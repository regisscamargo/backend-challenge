import { describe, expect, test } from "bun:test";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wagering/wager-transaction";
import { Money } from "../../src/domain/money/money";

const money = (amount: string) => Money.from({ amount, currency: "BRL" });
const base = {
  id: "transaction-1",
  providerId: "provider-a",
  externalTransactionId: "external-1",
  idempotencyKey: "provider-a:external-1",
  payloadHash: "a".repeat(64),
  walletId: "wallet-1",
  playerId: "player-1",
  roundId: "round-1",
  gameId: "game-1",
  createdAt: new Date("2026-10-03T12:00:00.000Z"),
};

describe("WagerTransaction", () => {
  test("starts pending and requires references only for reversals", () => {
    const bet = WagerTransaction.create({
      ...base,
      kind: WagerTransactionKind.Bet,
      money: money("25.00"),
    });

    expect(bet.status).toBe(WagerTransactionStatus.Pending);
    expect(bet.requiresReference()).toBe(false);
    expect(bet.affectsBalance()).toBe(true);
  });

  test("rejects opening and invalid reference contracts", () => {
    expect(() =>
      WagerTransaction.create({
        ...base,
        kind: WagerTransactionKind.Opening,
        money: money("25.00"),
      }),
    ).toThrow("OPENING_IS_INTERNAL");

    expect(() =>
      WagerTransaction.create({
        ...base,
        kind: WagerTransactionKind.Refund,
        money: money("25.00"),
      }),
    ).toThrow("REFERENCE_REQUIRED");
  });

  test("supports pending reference and terminal rejection", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const transaction = WagerTransaction.create({
      ...base,
      kind: WagerTransactionKind.Refund,
      money: money("25.00"),
      referenceExternalTransactionId: "bet-1",
    });

    transaction.markPendingReference(now);
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);

    transaction.reject(FailureCode.ReferenceTimeout);
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.ReferenceTimeout);
    expect(() => transaction.markPendingReference(now)).toThrow("INVALID_TRANSACTION_STATE");
  });

  test("returns original response balance information after processing", () => {
    const transaction = WagerTransaction.create({
      ...base,
      kind: WagerTransactionKind.Bet,
      money: money("25.00"),
    });
    const responseBalance = money("75.00");

    transaction.markProcessed(undefined, new Date(), responseBalance);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.responseBalance?.toString()).toBe("75.00");
    expect(transaction.matchesPayload("a".repeat(64))).toBe(true);
  });

  test("calculates rollback as the inverse of the reference direction", () => {
    const bet = WagerTransaction.create({
      ...base,
      id: "bet-1",
      kind: WagerTransactionKind.Bet,
      money: money("25.00"),
    });
    const rollback = WagerTransaction.create({
      ...base,
      id: "rollback-1",
      kind: WagerTransactionKind.Rollback,
      money: money("25.00"),
      referenceExternalTransactionId: "external-1",
    });

    expect(rollback.ledgerDirectionFor(bet)).toBe("CREDIT");
  });
});
