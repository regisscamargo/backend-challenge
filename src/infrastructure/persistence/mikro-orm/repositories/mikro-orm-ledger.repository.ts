import { LedgerRepository } from "../../../../application/wallet/ports";
import { Injectable } from "@nestjs/common";
import { TransactionContext } from "../../../../application/shared/unit-of-work";
import { WalletLedgerEntry } from "../../../../domain/ledger/wallet-ledger-entry";
import { requireEntityManager } from "../mikro-orm-context";
import { LedgerEntryOrmEntity } from "../entities/ledger-entry.orm-entity";

@Injectable()
export class MikroOrmLedgerRepository implements LedgerRepository {
  async insert(entry: WalletLedgerEntry, context: TransactionContext): Promise<void> {
    const em = requireEntityManager(context);

    em.persist(
      em.create(LedgerEntryOrmEntity, {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.money.toString(),
        currency: entry.money.currency,
        balanceBefore: entry.balanceBefore.toString(),
        balanceAfter: entry.balanceAfter.toString(),
        createdAt: entry.createdAt,
      }),
    );
  }
}
