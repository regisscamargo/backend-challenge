import { defineEntity, p } from "@mikro-orm/postgresql";

const WagerTransactionSchema = defineEntity({
  name: "WagerTransactionOrmEntity",
  tableName: "wager_transactions",
  properties: {
    id: p.string().type("uuid").primary(),
    providerId: p.string().length(100),
    externalTransactionId: p.string().length(255),
    idempotencyKey: p.string().length(255),
    payloadHash: p.string().length(64),
    walletId: p.string().type("uuid"),
    playerId: p.string().type("uuid"),
    roundId: p.string().length(255),
    gameId: p.string().length(255),
    kind: p.string().length(16),
    amount: p.decimal("string"),
    currency: p.string().length(3),
    status: p.string().length(32),
    referenceExternalTransactionId: p.string().length(255).nullable(),
    referenceTransactionId: p.string().type("uuid").nullable(),
    failureCode: p.string().length(64).nullable(),
    responseBalanceAmount: p.decimal("string").nullable(),
    responseBalanceCurrency: p.string().length(3).nullable(),
    createdAt: p.datetime(),
    processedAt: p.datetime().nullable(),
    referenceAttempts: p.integer().default(0),
    referenceNextAttemptAt: p.datetime().nullable(),
  },
});

export class WagerTransactionOrmEntity extends WagerTransactionSchema.class {}
WagerTransactionSchema.setClass(WagerTransactionOrmEntity);
