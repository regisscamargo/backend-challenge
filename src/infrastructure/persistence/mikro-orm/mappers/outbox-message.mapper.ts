import { OutboxMessage } from "../../../../domain/outbox/outbox-message";
import { OutboxMessageOrmEntity } from "../entities/outbox-message.orm-entity";

export const OutboxMessageMapper = {
  toDomain(record: OutboxMessageOrmEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload as Readonly<Record<string, unknown>>,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      ...(record.nextAttemptAt ? { nextAttemptAt: record.nextAttemptAt } : {}),
      ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
    });
  },
};
