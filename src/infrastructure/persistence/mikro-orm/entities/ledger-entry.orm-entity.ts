import { defineEntity, p } from "@mikro-orm/postgresql";

const LedgerEntrySchema = defineEntity({
  name: "LedgerEntryOrmEntity",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.string().type("uuid").primary(),
    walletId: p.string().type("uuid"),
    transactionId: p.string().type("uuid"),
    direction: p.string().length(6),
    amount: p.decimal("string"),
    currency: p.string().length(3),
    balanceBefore: p.decimal("string"),
    balanceAfter: p.decimal("string"),
    createdAt: p.datetime(),
  },
});

export class LedgerEntryOrmEntity extends LedgerEntrySchema.class {}
LedgerEntrySchema.setClass(LedgerEntryOrmEntity);
