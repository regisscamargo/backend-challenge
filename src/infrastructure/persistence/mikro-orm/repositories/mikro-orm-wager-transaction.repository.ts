import { WagerTransactionRepository } from "../../../../application/wallet/ports";
import { Injectable } from "@nestjs/common";
import { TransactionContext } from "../../../../application/shared/unit-of-work";
import { WagerTransaction } from "../../../../domain/wagering/wager-transaction";
import { requireEntityManager } from "../mikro-orm-context";
import { WagerTransactionOrmEntity } from "../entities/wager-transaction.orm-entity";
import { WagerTransactionMapper } from "../mappers/wager-transaction.mapper";

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
    context: TransactionContext,
  ): Promise<WagerTransaction | null> {
    const em = requireEntityManager(context);
    const record = await em.findOne(WagerTransactionOrmEntity, {
      providerId,
      idempotencyKey,
    }, { refresh: true });

    return record ? WagerTransactionMapper.toDomain(record) : null;
  }

  async findByExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
    context: TransactionContext,
  ): Promise<WagerTransaction | null> {
    const em = requireEntityManager(context);
    const record = await em.findOne(WagerTransactionOrmEntity, {
      providerId,
      externalTransactionId,
    });
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }

  async findByReference(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransaction["kind"],
    context: TransactionContext,
  ): Promise<WagerTransaction | null> {
    const em = requireEntityManager(context);
    const record = await em.findOne(WagerTransactionOrmEntity, {
      providerId,
      referenceExternalTransactionId,
      kind,
      status: "PROCESSED",
    });
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }

  async findPendingReferences(limit: number, now: Date, context: TransactionContext): Promise<WagerTransaction[]> {
    const em = requireEntityManager(context);
    const records = await em.find(
      WagerTransactionOrmEntity,
      {
        status: "PENDING_REFERENCE",
        $or: [
          { referenceNextAttemptAt: null },
          { referenceNextAttemptAt: { $lte: now } },
        ],
      },
      { limit, orderBy: { createdAt: "ASC" } },
    );
    return records.map((record) => WagerTransactionMapper.toDomain(record));
  }

  async insert(transaction: WagerTransaction, context: TransactionContext): Promise<void> {
    const em = requireEntityManager(context);
    em.persist(
      em.create(WagerTransactionOrmEntity, WagerTransactionMapper.toPersistence(transaction), {
        partial: true,
      }),
    );
    await em.flush();
  }

  async save(transaction: WagerTransaction, context: TransactionContext): Promise<void> {
    const em = requireEntityManager(context);
    await em.nativeUpdate(
      WagerTransactionOrmEntity,
      { id: transaction.id },
      WagerTransactionMapper.toPersistence(transaction),
    );
  }
}
