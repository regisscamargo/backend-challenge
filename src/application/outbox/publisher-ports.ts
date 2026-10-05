import { OutboxMessage } from "../../domain/outbox/outbox-message";

export interface ClaimableOutboxRepository {
  claimDue(now: Date, workerId: string, limit: number): Promise<OutboxMessage[]>;
  markPublished(id: string, workerId: string, at: Date): Promise<void>;
  markPublishedBatch(ids: readonly string[], workerId: string, at: Date): Promise<void>;
  scheduleRetry(id: string, workerId: string, now: Date, errorMessage: string): Promise<void>;
}

export interface BatchPublishResult {
  publishedMessageIds: readonly string[];
  failures: readonly { messageId: string; reason: string }[];
}

export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
  publishBatch?(messages: readonly OutboxMessage[]): Promise<BatchPublishResult>;
}
