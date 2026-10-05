import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { isUUID } from "class-validator";
import { DomainError } from "../../../domain/shared/domain-error";
import { Money } from "../../../domain/money/money";
import { WalletOrmEntity } from "./entities/wallet.orm-entity";
import { LedgerEntryOrmEntity } from "./entities/ledger-entry.orm-entity";
import { WagerTransactionOrmEntity } from "./entities/wager-transaction.orm-entity";

@Injectable()
export class WageringQueries {
  constructor(private readonly entityManager: EntityManager) {}

  async wallet(id: string) {
    const wallet = await this.entityManager.fork().findOne(WalletOrmEntity, { id });
    if (!wallet) throw new DomainError("WALLET_NOT_FOUND", "Wallet was not found");
    return { id: wallet.id, playerId: wallet.playerId,
      balance: Money.from({ amount: wallet.balance, currency: wallet.currency }).toJSON(), version: wallet.version };
  }

  async transaction(filter: { id: string } | { providerId: string; externalTransactionId: string }) {
    const tx = await this.entityManager.fork().findOne(WagerTransactionOrmEntity, filter);
    if (!tx) throw new DomainError("TRANSACTION_NOT_FOUND", "Transaction was not found");
    return {
      transactionId: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId,
      kind: tx.kind, status: tx.status, money: Money.from({ amount: tx.amount, currency: tx.currency }).toJSON(),
      ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
      ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      ...(tx.responseBalanceAmount != null && tx.responseBalanceCurrency
        ? { balance: Money.from({ amount: tx.responseBalanceAmount, currency: tx.responseBalanceCurrency }).toJSON() } : {}),
      createdAt: tx.createdAt.toISOString(), processedAt: tx.processedAt?.toISOString() ?? null,
    };
  }

  async ledger(walletId: string, limit = 50, cursor?: string) {
    await this.wallet(walletId);
    const em = this.entityManager.fork();
    let anchor: string | undefined;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<string, unknown>;
        if (decoded.v !== 1 || decoded.walletId !== walletId || typeof decoded.id !== "string" || !isUUID(decoded.id)) throw new Error();
        anchor = decoded.id;
        if (!await em.findOne(LedgerEntryOrmEntity, { id: anchor, walletId })) throw new Error();
      } catch {
        throw new DomainError("INVALID_CURSOR", "Cursor is invalid for this wallet");
      }
    }
    // Compare the database timestamp directly, preserving microsecond precision.
    const rows = await em.getConnection().execute<{ id: string }[]>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?
       ${anchor ? "AND (created_at, id) > (SELECT created_at, id FROM wallet_ledger_entries WHERE id = ? AND wallet_id = ?)" : ""}
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      anchor ? [walletId, anchor, walletId, limit + 1] : [walletId, limit + 1],
    );
    const ids = rows.slice(0, limit).map((row) => row.id);
    const entries = ids.length ? await em.find(LedgerEntryOrmEntity, { id: { $in: ids }, walletId },
      { orderBy: { createdAt: "ASC", id: "ASC" } }) : [];
    const last = entries.at(-1);
    return {
      items: entries.map((entry) => ({
        id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
        direction: entry.direction, money: Money.from({ amount: entry.amount, currency: entry.currency }).toJSON(),
        balanceBefore: Money.from({ amount: entry.balanceBefore, currency: entry.currency }).toJSON(),
        balanceAfter: Money.from({ amount: entry.balanceAfter, currency: entry.currency }).toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: 1, walletId, id: last.id })).toString("base64url") : null,
    };
  }
}
