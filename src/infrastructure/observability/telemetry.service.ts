import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { ProcessingObservation, ProcessingTelemetry } from "../../application/shared/telemetry";

@Injectable()
export class TelemetryService implements ProcessingTelemetry {
  readonly registry = new Registry();
  private readonly transactions = new Counter({ name: "wager_transactions_total", help: "Completed processing attempts by resulting status, excluding replay", labelNames: ["status"], registers: [this.registry] });
  private readonly duplicates = new Counter({ name: "wager_duplicates_total", help: "Idempotent replays", registers: [this.registry] });
  private readonly retries = new Counter({ name: "wager_retries_total", help: "Retry attempts for references and scheduled Outbox retries", labelNames: ["source"], registers: [this.registry] });
  private readonly lockFailures = new Counter({ name: "wager_lock_conflicts_total", help: "Database lock or serialization failures", labelNames: ["code"], registers: [this.registry] });
  private readonly latency = new Histogram({ name: "wager_processing_duration_seconds", help: "Use case latency including lock waits and replays", buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1, 5], registers: [this.registry] });
  readonly divergences = new Counter({ name: "wallet_reconciliation_divergences_total", help: "Reconciliation checks with divergence", registers: [this.registry] });
  readonly outboxLag = new Gauge({ name: "wager_outbox_lag_seconds", help: "Age of oldest unpublished event", registers: [this.registry] });
  readonly outboxPending = new Gauge({ name: "wager_outbox_pending", help: "Unpublished Outbox rows", registers: [this.registry] });
  readonly dlqMessages = new Gauge({ name: "wager_dlq_messages", help: "Approximate visible plus inflight DLQ messages", registers: [this.registry] });
  readonly dependencyUp = new Gauge({ name: "wager_metrics_dependency_up", help: "Successful scrape of dependency metrics", labelNames: ["dependency"], registers: [this.registry] });

  record(observation: ProcessingObservation): void {
    this.latency.observe(observation.durationSeconds);
    if (observation.replay) this.duplicates.inc();
    else this.transactions.inc({ status: observation.status });
    // Explicit allowlist: never serialize commands, amounts, SQL errors or payloads.
    process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level: observation.status === "ERROR" ? "error" : "info",
      event: "wager_processing_completed", correlationId: observation.correlationId,
      messageId: observation.messageId ?? null, transactionId: observation.transactionId ?? null,
      walletId: observation.walletId, providerId: observation.providerId,
      status: observation.status, idempotentReplay: observation.replay }) + "\n");
  }
  retry(source: "reference" | "outbox" | "sqs"): void { this.retries.inc({ source }); }
  lockFailure(code: string): void {
    if (["40P01", "55P03", "40001"].includes(code)) this.lockFailures.inc({ code });
  }
}
