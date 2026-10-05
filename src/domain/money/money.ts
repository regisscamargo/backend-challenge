import Decimal from "decimal.js";
import { DomainError } from "../shared/domain-error";

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Normalize PostgreSQL aggregates such as "0"; HTTP and SQS enforce the
const DECIMAL_AMOUNT = /^-?(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;


export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!ISO_CURRENCY.test(props.currency)) {
      throw new DomainError(
        "INVALID_CURRENCY",
        "Currency must be an uppercase ISO-4217 code",
      );
    }

    if (!DECIMAL_AMOUNT.test(props.amount)) {
      throw new DomainError(
        "INVALID_MONEY_AMOUNT",
        "Amount must be a decimal value that fits NUMERIC(15,2)",
      );
    }

    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(
        "CURRENCY_MISMATCH",
        `Cannot operate on ${this.currency} and ${other.currency}`,
      );
    }
  }
}
