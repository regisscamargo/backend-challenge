import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { LedgerDirection } from "../../src/domain/wallet/wallet";
import { WalletLedgerEntry } from "../../src/domain/ledger/wallet-ledger-entry";

const money = (amount: string) => Money.from({ amount, currency: "BRL" });
const createdAt = new Date("2026-10-03T12:00:00.000Z");

const base = {
  id: "ledger-1",
  walletId: "wallet-1",
  transactionId: "transaction-1",
  createdAt,
};

describe("WalletLedgerEntry", () => {
  test("creates a balanced debit entry", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: money("25.00"),
      balanceBefore: money("100.00"),
      balanceAfter: money("75.00"),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe("75.00");
  });

  test("creates a balanced credit entry", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: money("25.00"),
      balanceBefore: money("75.00"),
      balanceAfter: money("100.00"),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  test("rejects an arithmetic inconsistency", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: money("25.00"),
        balanceBefore: money("100.00"),
        balanceAfter: money("80.00"),
      }),
    ).toThrow("UNBALANCED_LEDGER_ENTRY");
  });

  test("rejects zero and foreign-currency entries", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: money("0.00"),
        balanceBefore: money("10.00"),
        balanceAfter: money("10.00"),
      }),
    ).toThrow("INVALID_LEDGER_AMOUNT");

    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: "5.00", currency: "USD" }),
        balanceBefore: money("10.00"),
        balanceAfter: money("15.00"),
      }),
    ).toThrow("CURRENCY_MISMATCH");
  });

  test("does not expose transition methods or mutable date state", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: money("25.00"),
      balanceBefore: money("75.00"),
      balanceAfter: money("100.00"),
    });

    const date = entry.createdAt;
    date.setFullYear(2030);

    expect(entry.createdAt.getFullYear()).toBe(2026);
    expect("markProcessed" in entry).toBe(false);
  });
});
