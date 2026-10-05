import { expect, spyOn, test } from "bun:test";
import { TelemetryService } from "../../src/infrastructure/observability/telemetry.service";

test("telemetry exports bounded metrics and logs only allowlisted correlation fields", async () => {
  const telemetry = new TelemetryService();
  const lines: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { lines.push(String(chunk)); return true; });
  try {
    const observation = {
      correlationId: "correlation", messageId: "message", transactionId: "transaction",
      walletId: "wallet", providerId: "provider", status: "PROCESSED", replay: false,
      durationSeconds: 0.01, payload: { money: { amount: "999.99" } }, authorization: "secret-token",
    };
    telemetry.record(observation);
    telemetry.record({ ...observation, replay: true });
    telemetry.retry("reference");
    telemetry.retry("outbox");
    telemetry.lockFailure("40P01");
    telemetry.lockFailure("arbitrary-input");
    const logged = JSON.parse(lines[0] ?? "{}");
    expect(logged.correlationId).toBe("correlation");
    expect(logged.transactionId).toBe("transaction");
    expect(logged.messageId).toBe("message");
    expect(lines.join("")).not.toContain("999.99");
    expect(lines.join("")).not.toContain("secret-token");
    expect(logged.payload).toBeUndefined();
    const metrics = await telemetry.registry.metrics();
    expect(metrics).toContain('wager_transactions_total{status="PROCESSED"} 1');
    expect(metrics).toContain("wager_duplicates_total 1");
    expect(metrics).toContain('wager_retries_total{source="reference"} 1');
    expect(metrics).toContain('wager_retries_total{source="outbox"} 1');
    expect(metrics).toContain('wager_lock_conflicts_total{code="40P01"} 1');
    expect(metrics).not.toContain("arbitrary-input");
    expect(metrics).toContain("wager_processing_duration_seconds_count 2");
  } finally { stdout.mockRestore(); }
});
