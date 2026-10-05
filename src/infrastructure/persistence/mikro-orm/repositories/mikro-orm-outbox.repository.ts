import { OutboxRepository } from "../../../../application/outbox/ports";
import { Injectable } from "@nestjs/common";
import { TransactionContext } from "../../../../application/shared/unit-of-work";
import { OutboxMessage } from "../../../../domain/outbox/outbox-message";
import { requireEntityManager } from "../mikro-orm-context";
import { OutboxMessageOrmEntity } from "../entities/outbox-message.orm-entity";

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
  async insert(message: OutboxMessage, context: TransactionContext): Promise<void> {
    const em = requireEntityManager(context);
    em.persist(
      em.create(
        OutboxMessageOrmEntity,
        {
          id: message.id,
          aggregateId: message.aggregateId,
          eventType: message.eventType,
          payload: message.payload,
          occurredAt: message.occurredAt,
          attempts: message.attempts,
          nextAttemptAt: message.nextAttemptAt ?? null,
          publishedAt: message.publishedAt ?? null,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
        { partial: true },
      ),
    );
  }
}
