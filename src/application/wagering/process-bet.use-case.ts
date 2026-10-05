import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { IdGenerator, LedgerRepository, WalletRepository, WagerTransactionRepository } from "../wallet/ports";
import { UnitOfWork, TransactionContext } from "../shared/unit-of-work";
import { OutboxRepository } from "../outbox/ports";
import { InboxRepository } from "../inbox/ports";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { DomainError } from "../../domain/shared/domain-error";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import { LedgerDirection, Wallet } from "../../domain/wallet/wallet";
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../domain/events/integration-event";
import { OutboxMessage } from "../../domain/outbox/outbox-message";
import { InboxMessage } from "../../domain/inbox/inbox-message";
import { Money } from "../../domain/money/money";
import type { ProcessingTelemetry } from "../shared/telemetry";

export interface ProcessBetInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind?: WagerTransactionKind;
  referenceExternalTransactionId?: string;
  money: Money;
  now: Date;
  inbox?: { messageId: string; consumerName: string; receivedAt: Date };
}

export interface ProcessBetOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: Money;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/** Historical name kept for the challenge API; it now processes the lifecycle. */
export class ProcessBetUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly transactions: WagerTransactionRepository,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly inbox?: InboxRepository,
    private readonly telemetry?: ProcessingTelemetry,
  ) {}

  async execute(input: ProcessBetInput): Promise<ProcessBetOutput> {
    return this.process(input, false);
  }

  async retryPendingReference(input: ProcessBetInput): Promise<ProcessBetOutput> {
    return this.process(input, true);
  }

  private async process(input: ProcessBetInput, retryPending: boolean): Promise<ProcessBetOutput> {
    const start = performance.now();
    let result: ProcessBetOutput | undefined;
    try {
      if (retryPending) this.telemetry?.retry("reference");
      try {
        result = await this.processWithinTransaction(input, retryPending);
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) throw error;
        result = await this.replayAfterConcurrentInsert(input);
      }
      return result;
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string") {
        this.telemetry?.lockFailure(error.code);
      }
      throw error;
    } finally {
      // Telemetry failure must never turn a committed financial result into an error.
      try {
        this.telemetry?.record({ correlationId: input.idempotencyKey,
          ...(input.inbox ? { messageId: input.inbox.messageId } : {}),
          ...(result ? { transactionId: result.transactionId } : {}),
          walletId: input.walletId, providerId: input.providerId, status: result?.status ?? "ERROR",
          replay: result?.idempotentReplay ?? false, durationSeconds: (performance.now() - start) / 1000 });
      } catch { /* Database result remains authoritative. */ }
    }
  }

  private async processWithinTransaction(input: ProcessBetInput, retryPending: boolean): Promise<ProcessBetOutput> {
    return this.unitOfWork.execute(async (context) => {
      let existing = await this.transactions.findByIdempotencyKey(input.providerId, input.idempotencyKey, context);
      let inboxMessage: InboxMessage | undefined;

      if (input.inbox) {
        const existingInbox = await this.inbox?.find(input.inbox.consumerName, input.inbox.messageId, context);
        if (existingInbox && existingInbox.payloadHash !== input.payloadHash) {
          throw new DomainError("INBOX_PAYLOAD_CONFLICT", "Message was redelivered with a different payload");
        }
        if (!existingInbox) {
          inboxMessage = InboxMessage.receive({
            messageId: input.inbox.messageId,
            consumerName: input.inbox.consumerName,
            payloadHash: input.payloadHash,
            receivedAt: input.inbox.receivedAt,
          });
          await this.inbox?.insert(inboxMessage, context);
        }
      }

      if (existing && (!retryPending || existing.status !== WagerTransactionStatus.PendingReference)) {
        await this.completeInbox(inboxMessage, input, context);
        return this.resolveExisting(existing, input.payloadHash);
      }

      const kind = input.kind ?? WagerTransactionKind.Bet;
      let transaction = existing ?? WagerTransaction.create({
          id: this.ids.generate(),
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
          payloadHash: input.payloadHash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind,
          money: input.money,
          ...(input.referenceExternalTransactionId ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}),
          createdAt: input.now,
        });

      if (existing && !existing.matchesPayload(input.payloadHash)) {
        throw new DomainError(FailureCode.IdempotencyConflict, "Idempotency key was used with a different payload");
      }

      const wallet = await this.wallets.findByIdForUpdate(input.walletId, context);
      if (!wallet) throw new DomainError("WALLET_NOT_FOUND", "Wallet was not found");
      if (wallet.playerId !== input.playerId) {
        throw new DomainError("WALLET_PLAYER_MISMATCH", "Wallet does not belong to player");
      }
      // Re-read after acquiring the wallet lock: another worker may have
      // completed this pending transaction while this worker was waiting.
      if (existing) {
        existing = await this.transactions.findByIdempotencyKey(input.providerId, input.idempotencyKey, context);
        if (!existing) throw new DomainError("INVALID_TRANSACTION_STATE", "Pending transaction disappeared");
        transaction = existing;
        if (existing.status !== WagerTransactionStatus.PendingReference) {
          await this.completeInbox(inboxMessage, input, context);
          return this.resolveExisting(existing, input.payloadHash);
        }
        if (existing.referenceNextAttemptAt && existing.referenceNextAttemptAt > input.now) {
          return this.resolveExisting(existing, input.payloadHash);
        }
      }
      if (!existing) await this.transactions.insert(transaction, context);

      const reference = await this.resolveReference(transaction, context);
      if (reference === null && transaction.referenceExternalTransactionId) {
        if (transaction.referenceAttempts >= 5) {
          return this.persistRejected(transaction, wallet, FailureCode.ReferenceNotFound, input, inboxMessage, context);
        }
        transaction.markPendingReference(input.now);
        await this.transactions.save(transaction, context);
        await this.outbox.insert(OutboxMessage.enqueue(WagerTransactionPendingReference.create({
          eventId: this.ids.generate(),
          aggregateId: transaction.id,
          correlationId: input.idempotencyKey,
          occurredAt: input.now,
          data: {
            transactionId: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            kind: transaction.kind,
            referenceExternalTransactionId: transaction.referenceExternalTransactionId,
            money: transaction.money.toJSON(),
          },
        })), context);
        await this.completeInbox(inboxMessage, input, context);
        return this.toOutput(transaction, false);
      }

      if (reference) {
        try {
          this.validateReference(transaction, reference);
        } catch (error) {
          if (!(error instanceof DomainError) ||
              ![FailureCode.InvalidReference, FailureCode.CurrencyMismatch].includes(error.code as FailureCode)) throw error;
          return this.persistRejected(transaction, wallet, error.code as FailureCode, input, inboxMessage, context);
        }
        if ([WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(transaction.kind)) {
          const previousReversal = await this.transactions.findByReference(
            transaction.providerId,
            reference.externalTransactionId,
            transaction.kind,
            context,
          );
          if (previousReversal && previousReversal.id !== transaction.id) {
            return this.persistRejected(transaction, wallet, FailureCode.ReferenceAlreadyReversed, input, inboxMessage, context);
          }
        }
      }

      if (kind === WagerTransactionKind.Loss) {
        transaction.markProcessed(undefined, input.now, wallet.balance);
        await this.transactions.save(transaction, context);
        await this.insertProcessedEvent(transaction, wallet, input, context);
        await this.completeInbox(inboxMessage, input, context);
        return this.toOutput(transaction, false);
      }

      try {
        const direction = transaction.ledgerDirectionFor(reference ?? undefined) === "DEBIT"
          ? LedgerDirection.Debit
          : LedgerDirection.Credit;
        const change = direction === LedgerDirection.Debit
          ? wallet.debit(input.money, input.now)
          : wallet.credit(input.money, input.now);
        const ledgerEntry = WalletLedgerEntry.create({
          id: this.ids.generate(),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction,
          money: change.money,
          balanceBefore: change.balanceBefore,
          balanceAfter: change.balanceAfter,
          createdAt: input.now,
        });
        transaction.markProcessed(reference?.id, input.now, wallet.balance);
        await this.wallets.save(wallet, context);
        await this.ledger.insert(ledgerEntry, context);
        await this.transactions.save(transaction, context);
        await this.insertProcessedEvent(transaction, wallet, input, context);
        await this.outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.create({
          eventId: this.ids.generate(),
          aggregateId: wallet.id,
          correlationId: input.idempotencyKey,
          causationId: transaction.id,
          occurredAt: input.now,
          data: {
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: change.direction,
            money: change.money.toJSON(),
            balanceBefore: change.balanceBefore.toJSON(),
            balanceAfter: change.balanceAfter.toJSON(),
            walletVersion: change.walletVersion,
          },
        })), context);
        await this.completeInbox(inboxMessage, input, context);
        return this.toOutput(transaction, false);
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "INSUFFICIENT_FUNDS") throw error;
        const failureCode = kind === WagerTransactionKind.Bet
          ? FailureCode.InsufficientFunds
          : FailureCode.ReversalWouldCreateNegativeBalance;
        return this.persistRejected(transaction, wallet, failureCode, input, inboxMessage, context);
      }
    });
  }

  private async resolveReference(transaction: WagerTransaction, context: TransactionContext): Promise<WagerTransaction | undefined | null> {
    if (!transaction.referenceExternalTransactionId) return undefined;
    return this.transactions.findByExternalTransactionId(transaction.providerId, transaction.referenceExternalTransactionId, context);
  }

  private validateReference(transaction: WagerTransaction, reference: WagerTransaction): void {
    if (reference.money.currency !== transaction.money.currency) {
      throw new DomainError(FailureCode.CurrencyMismatch, "Reference currency differs from transaction");
    }
    if (
      reference.providerId !== transaction.providerId ||
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.roundId !== transaction.roundId ||
      reference.status !== WagerTransactionStatus.Processed
    ) {
      throw new DomainError(FailureCode.InvalidReference, "Reference does not match the transaction");
    }
    if (
      [WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(transaction.kind) &&
      !reference.money.equals(transaction.money)
    ) {
      throw new DomainError(FailureCode.InvalidReference, "Reversal amount must equal the reference amount");
    }
    if (transaction.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
      throw new DomainError(FailureCode.InvalidReference, "Refund must reference a BET");
    }
    if (transaction.kind === WagerTransactionKind.Win && reference.kind !== WagerTransactionKind.Bet) {
      throw new DomainError(FailureCode.InvalidReference, "WIN must reference a BET");
    }
    if (
      transaction.kind === WagerTransactionKind.Rollback &&
      ![WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund].includes(reference.kind)
    ) {
      throw new DomainError(FailureCode.InvalidReference, "Rollback references an unsupported transaction kind");
    }
  }

  private async persistRejected(
    transaction: WagerTransaction,
    wallet: Wallet,
    failureCode: FailureCode,
    input: ProcessBetInput,
    inboxMessage: InboxMessage | undefined,
    context: TransactionContext,
  ): Promise<ProcessBetOutput> {
    transaction.reject(failureCode, wallet.balance);
    await this.transactions.save(transaction, context);
    await this.outbox.insert(OutboxMessage.enqueue(WagerTransactionRejected.create({
      eventId: this.ids.generate(),
      aggregateId: transaction.id,
      correlationId: input.idempotencyKey,
      occurredAt: input.now,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode,
        balance: wallet.balance.toJSON(),
      },
    })), context);
    await this.completeInbox(inboxMessage, input, context);
    return this.toOutput(transaction, false);
  }

  private async insertProcessedEvent(transaction: WagerTransaction, wallet: Wallet, input: ProcessBetInput, context: TransactionContext): Promise<void> {
    await this.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.create({
      eventId: this.ids.generate(),
      aggregateId: transaction.id,
      correlationId: input.idempotencyKey,
      occurredAt: input.now,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        status: transaction.status,
        balance: wallet.balance.toJSON(),
      },
    })), context);
  }

  private async completeInbox(inboxMessage: InboxMessage | undefined, input: ProcessBetInput, context: TransactionContext): Promise<void> {
    if (!inboxMessage) return;
    inboxMessage.markProcessed(input.now);
    await this.inbox?.save(inboxMessage, context);
  }

  private async replayAfterConcurrentInsert(input: ProcessBetInput): Promise<ProcessBetOutput> {
    return this.unitOfWork.execute(async (context) => {
      const existing = await this.transactions.findByIdempotencyKey(input.providerId, input.idempotencyKey, context);
      if (existing) return this.resolveExisting(existing, input.payloadHash);

      const sameExternalId = await this.transactions.findByExternalTransactionId(
        input.providerId,
        input.externalTransactionId,
        context,
      );
      if (sameExternalId) {
        throw new DomainError(
          FailureCode.IdempotencyConflict,
          "External transaction ID is already associated with a different idempotency key",
        );
      }

      throw new DomainError("IDEMPOTENCY_REPLAY_NOT_FOUND", "Unique constraint conflict did not leave a matching transaction");
    });
  }

  private resolveExisting(existing: WagerTransaction, payloadHash: string): ProcessBetOutput {
    if (!existing.matchesPayload(payloadHash)) {
      throw new DomainError(FailureCode.IdempotencyConflict, "Idempotency key was used with a different payload");
    }
    return this.toOutput(existing, true);
  }

  private toOutput(transaction: WagerTransaction, idempotentReplay: boolean): ProcessBetOutput {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      ...(transaction.responseBalance ? { balance: transaction.responseBalance } : {}),
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
      idempotentReplay,
    };
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof UniqueConstraintViolationException ||
    (error instanceof Error && "code" in error && error.code === "23505");
}
