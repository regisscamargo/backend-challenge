import { defineEntity, p } from "@mikro-orm/postgresql";

const WalletSchema = defineEntity({
  name: "WalletOrmEntity",
  tableName: "wallets",
  properties: {
    id: p.string().type("uuid").primary(),
    playerId: p.string().type("uuid"),
    currency: p.string().length(3),
    balance: p.decimal("string"),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export class WalletOrmEntity extends WalletSchema.class {}
WalletSchema.setClass(WalletOrmEntity);
