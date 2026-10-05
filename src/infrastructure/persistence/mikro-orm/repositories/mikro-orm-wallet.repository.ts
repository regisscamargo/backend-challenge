import { LockMode } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";
import { WalletRepository } from "../../../../application/wallet/ports";
import { TransactionContext } from "../../../../application/shared/unit-of-work";
import { Wallet } from "../../../../domain/wallet/wallet";
import { requireEntityManager } from "../mikro-orm-context";
import { WalletOrmEntity } from "../entities/wallet.orm-entity";
import { WalletMapper } from "../mappers/wallet.mapper";

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
  async insert(wallet: Wallet, context: TransactionContext): Promise<void> {
    const em = requireEntityManager(context);
    em.persist(em.create(WalletOrmEntity, {
      id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
      balance: wallet.balance.toString(), version: wallet.version,
      createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
    }));
    await em.flush();
  }

  async findByIdForUpdate(
    walletId: string,
    context: TransactionContext,
  ): Promise<Wallet | null> {
    const em = requireEntityManager(context);
    const record = await em.findOne(
      WalletOrmEntity,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    return record ? WalletMapper.toDomain(record) : null;
  }

  async save(wallet: Wallet, context: TransactionContext): Promise<void> {
    const em = requireEntityManager(context);
    await em.nativeUpdate(
      WalletOrmEntity,
      { id: wallet.id },
      WalletMapper.toPersistence(wallet),
    );
  }
}
