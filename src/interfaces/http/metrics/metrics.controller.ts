import { Controller, Get, Header, Inject } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { TelemetryService } from "../../../infrastructure/observability/telemetry.service";
import { SQS_CLIENT } from "../health/health.controller";

const dlqQueueUrl = process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL;
if (!dlqQueueUrl) throw new Error("SQS_WAGER_TRANSACTIONS_DLQ_URL must be configured");

@Controller("metrics")
export class MetricsController {
  constructor(private readonly telemetry: TelemetryService, private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async get(): Promise<string> {
    await Promise.all([this.databaseMetrics(), this.queueMetrics()]);
    return this.telemetry.registry.metrics();
  }

  private async databaseMetrics(): Promise<void> {
    try {
      const [row] = await this.em.getConnection().execute<{ pending: string; lag: string }[]>(
        `SELECT COUNT(*)::text AS pending,
         COALESCE(GREATEST(EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))), 0), 0)::text AS lag
         FROM outbox_messages WHERE published_at IS NULL`);
      if (!row) throw new Error("Missing aggregate");
      this.telemetry.outboxPending.set(Number(row.pending));
      this.telemetry.outboxLag.set(Number(row.lag));
      this.telemetry.dependencyUp.set({ dependency: "postgres" }, 1);
    } catch { this.telemetry.dependencyUp.set({ dependency: "postgres" }, 0); }
  }

  private async queueMetrics(): Promise<void> {
    try {
      const response = await this.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: dlqQueueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }), { abortSignal: AbortSignal.timeout(2_000) });
      this.telemetry.dlqMessages.set(Number(response.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0));
      this.telemetry.dependencyUp.set({ dependency: "sqs" }, 1);
    } catch { this.telemetry.dependencyUp.set({ dependency: "sqs" }, 0); }
  }
}
