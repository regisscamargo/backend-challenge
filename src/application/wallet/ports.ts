import { Wallet } from "../../domain/wallet/wallet";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { TransactionContext } from "../shared/unit-of-work";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";

export interface WalletRepository {
  findByIdForUpdate(
    walletId: string,
    context: TransactionContext,
  ): Promise<Wallet | null>;

  save(wallet: Wallet, context: TransactionContext): Promise<void>;
}

export interface WalletCreationRepository {
  insert(wallet: Wallet, context: TransactionContext): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry, context: TransactionContext): Promise<void>;
}

export interface IdGenerator {
  generate(): string;
}

export interface WagerTransactionRepository {
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
    context: TransactionContext,
  ): Promise<WagerTransaction | null>;

  findByExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
    context: TransactionContext,
  ): Promise<WagerTransaction | null>;

  findByReference(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransaction["kind"],
    context: TransactionContext,
  ): Promise<WagerTransaction | null>;

  findPendingReferences(limit: number, now: Date, context: TransactionContext): Promise<WagerTransaction[]>;

  insert(transaction: WagerTransaction, context: TransactionContext): Promise<void>;
  save(transaction: WagerTransaction, context: TransactionContext): Promise<void>;
}
