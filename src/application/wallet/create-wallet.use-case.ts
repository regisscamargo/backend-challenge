import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { UnitOfWork } from "../shared/unit-of-work";
import { IdGenerator, LedgerRepository, WalletCreationRepository, WagerTransactionRepository } from "./ports";
import { OutboxRepository } from "../outbox/ports";
import { hashCanonicalPayload } from "../wagering/payload-hash";
import { Money } from "../../domain/money/money";
import { LedgerDirection, Wallet } from "../../domain/wallet/wallet";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { DomainError } from "../../domain/shared/domain-error";
import { WalletBalanceChanged, WagerTransactionProcessed } from "../../domain/events/integration-event";
import { OutboxMessage } from "../../domain/outbox/outbox-message";

export class CreateWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly wallets: WalletCreationRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: { playerId: string; initialBalance: Money; now: Date }): Promise<Wallet> {
    try {
      return await this.unitOfWork.execute(async (context) => {
        const wallet = Wallet.open({ id: this.ids.generate(), ...input });
        await this.wallets.insert(wallet, context);
        if (input.initialBalance.isZero()) return wallet;
        const transaction = WagerTransaction.opening({
          id: this.ids.generate(), walletId: wallet.id, playerId: wallet.playerId,
          money: wallet.balance, now: input.now,
          payloadHash: hashCanonicalPayload({ playerId: wallet.playerId, initialBalance: wallet.balance.toJSON() }),
        });
        await this.transactions.insert(transaction, context);
        const entry = WalletLedgerEntry.create({
          id: this.ids.generate(), walletId: wallet.id, transactionId: transaction.id,
          direction: LedgerDirection.Credit, money: wallet.balance,
          balanceBefore: Money.zero(wallet.currency), balanceAfter: wallet.balance, createdAt: input.now,
        });
        await this.ledger.insert(entry, context);
        await this.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.create({
          eventId: this.ids.generate(), aggregateId: transaction.id, correlationId: transaction.idempotencyKey,
          occurredAt: input.now, data: {
            transactionId: transaction.id, providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId, kind: transaction.kind,
            money: wallet.balance.toJSON(), status: transaction.status, balance: wallet.balance.toJSON(),
          },
        })), context);
        await this.outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.create({
          eventId: this.ids.generate(), aggregateId: wallet.id, correlationId: transaction.idempotencyKey,
          causationId: transaction.id, occurredAt: input.now, data: {
            walletId: wallet.id, transactionId: transaction.id, direction: LedgerDirection.Credit,
            money: wallet.balance.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: wallet.balance.toJSON(), walletVersion: wallet.version,
          },
        })), context);
        return wallet;
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException &&
          "constraint" in error && error.constraint === "wallets_player_currency_unique") {
        throw new DomainError("WALLET_ALREADY_EXISTS", "Player already has a wallet in this currency");
      }
      throw error;
    }
  }
}
