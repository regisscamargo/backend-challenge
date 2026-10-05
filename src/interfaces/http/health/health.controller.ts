import { Controller, Get, HttpCode, HttpStatus, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";

export const SQS_CLIENT = Symbol("SQS_CLIENT");
export const SQS_TRANSACTIONS_QUEUE_URL = Symbol("SQS_TRANSACTIONS_QUEUE_URL");

@Injectable()
export class ReadinessProbe {
  constructor(
    private readonly entityManager: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(SQS_TRANSACTIONS_QUEUE_URL) private readonly queueUrl: string,
  ) {}

  async check(): Promise<{ status: "ok" | "down"; dependencies: Record<string, string> }> {
    try {
      await this.entityManager.getConnection().execute("SELECT 1");
      await this.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages"],
      }));
      return { status: "ok", dependencies: { postgres: "up", sqs: "up" } };
    } catch {
      return { status: "down", dependencies: { postgres: "unknown", sqs: "unknown" } };
    }
  }
}

@Controller("health")
export class HealthController {
  constructor(private readonly readiness: ReadinessProbe) {}

  @Get("live")
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    const result = await this.readiness.check();
    if (result.status === "down") {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
