import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/shared/domain-error";
import { Money } from "../../src/domain/money/money";
import { LedgerDirection, Wallet } from "../../src/domain/wallet/wallet";

const money = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-10-03T12:00:00.000Z");

describe("Wallet", () => {
  test("opens with version one", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("100.00"),
      now,
    });

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("debits and returns the exact ledger information", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("100.00"),
      now,
    });

    const change = wallet.debit(money("25.00"), now);

    expect(change.direction).toBe(LedgerDirection.Debit);
    expect(change.balanceBefore.toString()).toBe("100.00");
    expect(change.balanceAfter.toString()).toBe("75.00");
    expect(change.walletVersion).toBe(2);
    expect(wallet.balance.toString()).toBe("75.00");
  });

  test("rejects a debit that would make the balance negative", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("20.00"),
      now,
    });

    expect(() => wallet.debit(money("25.00"), now)).toThrow("INSUFFICIENT_FUNDS");
    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(1);
  });

  test("rejects a negative initial balance", () => {
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: money("-1.00"),
        now,
      }),
    ).toThrow("INVALID_INITIAL_BALANCE");
  });

  test("rejects zero, negative, and foreign-currency movements", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("20.00"),
      now,
    });

    expect(() => wallet.credit(money("0.00"), now)).toThrow(DomainError);
    expect(() => wallet.credit(money("-1.00"), now)).toThrow(DomainError);
    expect(() => wallet.credit(Money.from({ amount: "1.00", currency: "USD" }), now)).toThrow(
      "CURRENCY_MISMATCH",
    );
  });
});
