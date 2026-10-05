import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

/**
 * Deliberately no-op for the take-home challenge. In production this boundary
 * is where JWT validation and provider identity extraction would be attached.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
