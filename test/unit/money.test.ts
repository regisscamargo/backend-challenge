import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/shared/domain-error";
import { Money } from "../../src/domain/money/money";

describe("Money", () => {
  test("performs exact decimal arithmetic and fixed-scale serialization", () => {
    const result = Money.from({ amount: "0.10", currency: "BRL" }).add(
      Money.from({ amount: "0.20", currency: "BRL" }),
    );

    expect(result.toString()).toBe("0.30");
    expect(result.toJSON()).toEqual({ amount: "0.30", currency: "BRL" });
  });

  test("rejects invalid amount formats", () => {
    for (const amount of ["", "25.000", "10000000000000.00", "1e2", "NaN", "Infinity", "abc"]) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(DomainError);
    }
  });

  test("normalizes database decimal strings to fixed-scale output", () => {
    expect(Money.from({ amount: "25", currency: "BRL" }).toString()).toBe("25.00");
    expect(Money.from({ amount: "25.0", currency: "BRL" }).toString()).toBe("25.00");
  });

  test("rejects operations across currencies", () => {
    const brl = Money.from({ amount: "10.00", currency: "BRL" });
    const usd = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow("CURRENCY_MISMATCH");
  });

  test("is immutable", () => {
    const original = Money.from({ amount: "10.00", currency: "BRL" });
    const result = original.add(Money.from({ amount: "5.00", currency: "BRL" }));

    expect(original.toString()).toBe("10.00");
    expect(result.toString()).toBe("15.00");
  });
});
