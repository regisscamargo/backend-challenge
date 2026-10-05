import { EntityData } from "@mikro-orm/core";
import { Money } from "../../../../domain/money/money";
import {
  WagerTransaction,
  WagerTransactionState,
} from "../../../../domain/wagering/wager-transaction";
import { WagerTransactionOrmEntity } from "../entities/wager-transaction.orm-entity";

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionOrmEntity): WagerTransaction {
    const responseBalance =
      record.responseBalanceAmount && record.responseBalanceCurrency
        ? Money.from({
            amount: record.responseBalanceAmount,
            currency: record.responseBalanceCurrency,
          })
        : undefined;

    const state: WagerTransactionState = {
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionState["kind"],
      money: Money.from({ amount: record.amount, currency: record.currency }),
      ...(record.referenceExternalTransactionId
        ? { referenceExternalTransactionId: record.referenceExternalTransactionId }
        : {}),
      createdAt: record.createdAt,
      status: record.status as WagerTransactionState["status"],
      ...(record.referenceTransactionId
        ? { referenceTransactionId: record.referenceTransactionId }
        : {}),
      ...(record.failureCode
        ? { failureCode: record.failureCode as NonNullable<WagerTransactionState["failureCode"]> }
        : {}),
      ...(record.processedAt ? { processedAt: record.processedAt } : {}),
      ...(responseBalance ? { responseBalance } : {}),
      referenceAttempts: record.referenceAttempts,
      ...(record.referenceNextAttemptAt ? { referenceNextAttemptAt: record.referenceNextAttemptAt } : {}),
    };

    return WagerTransaction.rehydrate(state);
  },

  toPersistence(transaction: WagerTransaction): EntityData<WagerTransactionOrmEntity> {
    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: transaction.money.toString(),
      currency: transaction.money.currency,
      status: transaction.status,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      failureCode: transaction.failureCode ?? null,
      responseBalanceAmount: transaction.responseBalance?.toString() ?? null,
      responseBalanceCurrency: transaction.responseBalance?.currency ?? null,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt ?? null,
      referenceAttempts: transaction.referenceAttempts,
      referenceNextAttemptAt: transaction.referenceNextAttemptAt ?? null,
    };
  },
};
