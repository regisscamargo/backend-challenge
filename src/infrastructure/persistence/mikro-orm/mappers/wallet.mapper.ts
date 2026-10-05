import { Money } from "../../../../domain/money/money";
import { Wallet } from "../../../../domain/wallet/wallet";
import { WalletOrmEntity } from "../entities/wallet.orm-entity";

export const WalletMapper = {
  toDomain(record: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: Money.from({ amount: record.balance, currency: record.currency }),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  toPersistence(wallet: Wallet): Pick<WalletOrmEntity, "balance" | "version" | "updatedAt"> {
    return {
      balance: wallet.balance.toString(),
      version: wallet.version,
      updatedAt: wallet.updatedAt,
    };
  },
};
