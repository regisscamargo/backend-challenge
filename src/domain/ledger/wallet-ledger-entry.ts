import { DomainError } from "../shared/domain-error";
import { LedgerDirection } from "../wallet/wallet";
import { Money } from "../money/money";

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {}

/** Immutable audit record for one balance movement. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {}

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new DomainError("INVALID_LEDGER_IDENTITY", "Ledger identity is required");
    }

    if (props.money.isZero() || !props.money.isPositive()) {
      throw new DomainError("INVALID_LEDGER_AMOUNT", "Ledger amount must be positive");
    }

    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new DomainError("CURRENCY_MISMATCH", "Ledger values must use one currency");
    }

    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new DomainError("NEGATIVE_LEDGER_BALANCE", "Ledger balances cannot be negative");
    }

    const expectedAfter =
      props.direction === LedgerDirection.Debit
        ? props.balanceBefore.subtract(props.money)
        : props.balanceBefore.add(props.money);

    if (!expectedAfter.equals(props.balanceAfter)) {
      throw new DomainError(
        "UNBALANCED_LEDGER_ENTRY",
        "Ledger balanceAfter does not match the movement",
      );
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt.getTime()),
    );
  }

  /** Rehydrates a row already accepted by persistence. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt.getTime()),
    );
  }

  isBalanced(): boolean {
    const expectedAfter =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expectedAfter.equals(this.balanceAfter);
  }
}
