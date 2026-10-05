import { randomUUID } from "node:crypto";
import { ClaimableOutboxRepository, EventPublisher } from "./publisher-ports";
import type { ProcessingTelemetry } from "../shared/telemetry";

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  scheduledForRetry: number;
}

export class PublishOutboxUseCase {
  constructor(
    private readonly outbox: ClaimableOutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly telemetry?: ProcessingTelemetry,
  ) {}

  async execute(now: Date, limit = 100): Promise<PublishOutboxResult> {
    const workerId = randomUUID();
    const messages = await this.outbox.claimDue(now, workerId, limit);
    let published = 0;
    let scheduledForRetry = 0;

    // Keep each aggregate ordered; the runtime immediately claims the next page.
    const byAggregate = new Map<string, typeof messages>();
    for (const message of messages) {
      const group = byAggregate.get(message.aggregateId) ?? [];
      group.push(message);
      byAggregate.set(message.aggregateId, group);
    }
    const groups = [...byAggregate.values()];
    if (this.publisher.publishBatch && groups.every(group => group.length === 1)) {
      const batchPublisher = this.publisher.publishBatch.bind(this.publisher);
      for (let offset = 0; offset < groups.length; offset += 10) {
        const batch = groups.slice(offset, offset + 10).map(group => group[0]!);
        let publishedIds: string[] = [];
        let failures = new Map<string, string>();
        try {
          const result = await batchPublisher(batch);
          publishedIds = [...new Set(result.publishedMessageIds)];
          failures = new Map(result.failures.map(failure => [failure.messageId, failure.reason]));
          const successSet = new Set(publishedIds);
          for (const message of batch) {
            if (!successSet.has(message.id) && !failures.has(message.id)) {
              failures.set(message.id, "SQS batch response omitted this entry");
            }
          }
          publishedIds = publishedIds.filter(id => batch.some(message => message.id === id));
          await this.outbox.markPublishedBatch(publishedIds, workerId, now);
          published += publishedIds.length;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Unknown publisher error";
          publishedIds = [];
          failures = new Map(batch.map(message => [message.id, reason]));
        }
        for (const message of batch) {
          if (publishedIds.includes(message.id)) continue;
          await this.outbox.scheduleRetry(message.id, workerId, now, failures.get(message.id) ?? "SQS rejected the message");
          scheduledForRetry += 1;
          this.telemetry?.retry("outbox");
        }
      }
    } else {
      for (const group of groups) {
        for (const message of group) {
          try {
            await this.publisher.publish(message);
            await this.outbox.markPublished(message.id, workerId, now);
            published += 1;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown publisher error";
            await this.outbox.scheduleRetry(message.id, workerId, now, errorMessage);
            scheduledForRetry += 1;
            this.telemetry?.retry("outbox");
          }
        }
      }
    }

    return { claimed: messages.length, published, scheduledForRetry };
  }
}
