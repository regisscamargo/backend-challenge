import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { Response } from "express";
import { DomainError } from "../../../domain/shared/domain-error";

@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof DomainError) {
      response.status(statusFor(error.code)).json({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }
    if (isTransientInfrastructureError(error)) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: "INFRASTRUCTURE_UNAVAILABLE",
        message: "A required dependency is temporarily unavailable",
      });
      return;
    }
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    });
  }
}

function statusFor(code: string): number {
  if (code === "WALLET_ALREADY_EXISTS") return 409;
  if (code === "IDEMPOTENCY_CONFLICT" || code === "INBOX_PAYLOAD_CONFLICT") return 409;
  if (code === "WALLET_NOT_FOUND" || code === "TRANSACTION_NOT_FOUND") return 404;
  if (code === "INSUFFICIENT_FUNDS") return 422;
  if (code.startsWith("INVALID_") || code.endsWith("_REQUIRED") || code.endsWith("_NOT_ALLOWED")) {
    return 400;
  }
  return 422;
}

export function isTransientInfrastructureError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown; $retryable?: unknown };
  if (candidate.$retryable) return true;
  if (typeof candidate.code === "string" &&
    (candidate.code.startsWith("08") || ["40001", "40P01", "55P03", "57P01"].includes(candidate.code))) return true;
  return typeof candidate.name === "string" && [
    "TimeoutError", "NetworkingError", "ServiceUnavailable", "InternalError",
  ].includes(candidate.name);
}
