import { describe, expect, test } from "bun:test";
import { ApplyWalletMovementUseCase } from "../../src/application/wallet/apply-wallet-movement.use-case";
import { IdGenerator, LedgerRepository, WalletRepository } from "../../src/application/wallet/ports";
import { TransactionContext, UnitOfWork } from "../../src/application/shared/unit-of-work";
import { Money } from "../../src/domain/money/money";
import { LedgerDirection, Wallet } from "../../src/domain/wallet/wallet";
import { WalletLedgerEntry } from "../../src/domain/ledger/wallet-ledger-entry";

const money = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-10-03T12:00:00.000Z");

class FakeUnitOfWork implements UnitOfWork {
  public executions = 0;
  public committed = false;

  async execute<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
    this.executions += 1;
    const result = await work({ transactionId: "db-transaction-1" });
    this.committed = true;
    return result;
  }
}

class FakeWalletRepository implements WalletRepository {
  public saved?: Wallet;
  public lockedWalletId?: string;

  constructor(private readonly wallet: Wallet) {}

  async findByIdForUpdate(walletId: string): Promise<Wallet | null> {
    this.lockedWalletId = walletId;
    return walletId === this.wallet.id ? this.wallet : null;
  }

  async save(wallet: Wallet): Promise<void> {
    this.saved = wallet;
  }
}

class FakeLedgerRepository implements LedgerRepository {
  public inserted?: WalletLedgerEntry;

  async insert(entry: WalletLedgerEntry): Promise<void> {
    this.inserted = entry;
  }
}

class FixedIdGenerator implements IdGenerator {
  generate(): string {
    return "ledger-1";
  }
}

describe("ApplyWalletMovementUseCase", () => {
  test("locks the wallet, changes balance, saves it, and inserts its ledger entry", async () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("100.00"),
      now,
    });
    const unitOfWork = new FakeUnitOfWork();
    const wallets = new FakeWalletRepository(wallet);
    const ledger = new FakeLedgerRepository();
    const useCase = new ApplyWalletMovementUseCase(
      unitOfWork,
      wallets,
      ledger,
      new FixedIdGenerator(),
    );

    const output = await useCase.execute({
      walletId: "wallet-1",
      transactionId: "transaction-1",
      direction: LedgerDirection.Debit,
      money: money("25.00"),
      now,
    });

    expect(unitOfWork.executions).toBe(1);
    expect(unitOfWork.committed).toBe(true);
    expect(wallets.lockedWalletId).toBe("wallet-1");
    expect(wallets.saved).toBe(wallet);
    expect(ledger.inserted).toBeDefined();
    expect(output.wallet.balance.toString()).toBe("75.00");
    expect(output.ledgerEntry.isBalanced()).toBe(true);
  });

  test("does not save anything when the wallet does not exist", async () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("100.00"),
      now,
    });
    const unitOfWork = new FakeUnitOfWork();
    const wallets = new FakeWalletRepository(wallet);
    const ledger = new FakeLedgerRepository();
    const useCase = new ApplyWalletMovementUseCase(
      unitOfWork,
      wallets,
      ledger,
      new FixedIdGenerator(),
    );

    expect(
      useCase.execute({
        walletId: "missing-wallet",
        transactionId: "transaction-1",
        direction: LedgerDirection.Debit,
        money: money("25.00"),
        now,
      }),
    ).rejects.toThrow("WALLET_NOT_FOUND");

    expect(wallets.saved).toBeUndefined();
    expect(ledger.inserted).toBeUndefined();
    expect(unitOfWork.committed).toBe(false);
  });
});
