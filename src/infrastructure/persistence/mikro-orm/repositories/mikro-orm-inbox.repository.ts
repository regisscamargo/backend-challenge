import { InboxRepository } from "../../../../application/inbox/ports";
import { Injectable } from "@nestjs/common";
import { TransactionContext } from "../../../../application/shared/unit-of-work";
import { InboxMessage } from "../../../../domain/inbox/inbox-message";
import { requireEntityManager } from "../mikro-orm-context";
import { InboxMessageOrmEntity } from "../entities/inbox-message.orm-entity";

@Injectable()
export class MikroOrmInboxRepository implements InboxRepository {
  async find(
    consumerName: string,
    messageId: string,
    context: TransactionContext,
  ): Promise<InboxMessage | null> {
    const em = requireEntityManager(context);
    const record = await em.findOne(InboxMessageOrmEntity, { consumerName, messageId });
    return record
      ? InboxMessage.rehydrate({
          messageId: record.messageId,
          consumerName: record.consumerName,
          payloadHash: record.payloadHash,
          receivedAt: record.receivedAt,
          ...(record.processedAt ? { processedAt: record.processedAt } : {}),
        })
      : null;
  }

  async insert(message: InboxMessage, context: TransactionContext): Promise<void> {
    const em = requireEntityManager(context);
    em.persist(
      em.create(
        InboxMessageOrmEntity,
        {
          messageId: message.messageId,
          consumerName: message.consumerName,
          payloadHash: message.payloadHash,
          receivedAt: message.receivedAt,
          processedAt: message.processedAt ?? null,
        },
        { partial: true },
      ),
    );
  }

  async save(message: InboxMessage, context: TransactionContext): Promise<void> {
    const em = requireEntityManager(context);
    await em.nativeUpdate(
      InboxMessageOrmEntity,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}
