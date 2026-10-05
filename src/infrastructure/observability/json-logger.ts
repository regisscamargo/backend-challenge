import type { LoggerService } from "@nestjs/common";

/** Framework messages may contain SQL errors/payloads; retain only severity. */
export class JsonLogger implements LoggerService {
  private write(level: string): void {
    process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level, event: "nest_runtime" }) + "\n");
  }
  log(_message: unknown, ..._optional: unknown[]): void { this.write("info"); }
  error(_message: unknown, ..._optional: unknown[]): void { this.write("error"); }
  warn(_message: unknown, ..._optional: unknown[]): void { this.write("warn"); }
  debug(_message: unknown, ..._optional: unknown[]): void { this.write("debug"); }
  verbose(_message: unknown, ..._optional: unknown[]): void { this.write("debug"); }
}
