import { describe, expect, test } from "bun:test";
import { DomainErrorFilter, isTransientInfrastructureError } from "../../src/interfaces/http/errors/domain-error.filter";
import type { ArgumentsHost } from "@nestjs/common";

function capture(error: unknown): { status: number; body: unknown } {
  let status = 0;
  let body: unknown;
  const response = {
    status(value: number) { status = value; return this; },
    json(value: unknown) { body = value; return this; },
  };
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
  new DomainErrorFilter().catch(error, host);
  return { status, body };
}

describe("HTTP infrastructure error contract", () => {
  test("recognizes retryable PostgreSQL and transport failures", () => {
    for (const code of ["08006", "40001", "40P01", "55P03", "57P01"]) {
      expect(isTransientInfrastructureError({ code })).toBe(true);
    }
    expect(isTransientInfrastructureError({ name: "TimeoutError" })).toBe(true);
    expect(isTransientInfrastructureError({ $retryable: { throttling: true } })).toBe(true);
    expect(capture({ code: "08006" })).toEqual({
      status: 503,
      body: { error: "INFRASTRUCTURE_UNAVAILABLE", message: "A required dependency is temporarily unavailable" },
    });
  });

  test("does not classify programming and validation failures as transient", () => {
    expect(isTransientInfrastructureError(new Error("bug"))).toBe(false);
    expect(isTransientInfrastructureError({ code: "23505" })).toBe(false);
    expect(isTransientInfrastructureError(null)).toBe(false);
    expect(capture(new Error("database password leaked here"))).toEqual({
      status: 500,
      body: { error: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
    });
  });
});
