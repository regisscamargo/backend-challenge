import { DomainError } from "../shared/domain-error";
import { Money } from "../money/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletBalanceChange {
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): Wallet {
    if (!props.id || !props.playerId) {
      throw new DomainError("INVALID_WALLET_IDENTITY", "Wallet identity is required");
    }

    if (!props.initialBalance.isPositive() && !props.initialBalance.isZero()) {
      throw new DomainError(
        "INVALID_INITIAL_BALANCE",
        "Initial balance cannot be negative",
      );
    }

    const now = new Date(props.now?.getTime() ?? Date.now());
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  debit(amount: Money, now: Date = new Date()): WalletBalanceChange {
    this.assertValidMovement(amount);

    if (this._balance.isLessThan(amount)) {
      throw new DomainError(
        "INSUFFICIENT_FUNDS",
        "Wallet balance is insufficient",
      );
    }

    return this.applyMovement(LedgerDirection.Debit, amount, this._balance.subtract(amount), now);
  }

  credit(amount: Money, now: Date = new Date()): WalletBalanceChange {
    this.assertValidMovement(amount);
    return this.applyMovement(LedgerDirection.Credit, amount, this._balance.add(amount), now);
  }

  private applyMovement(
    direction: LedgerDirection,
    amount: Money,
    balanceAfter: Money,
    now: Date,
  ): WalletBalanceChange {
    const balanceBefore = this._balance;
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(now.getTime());

    return {
      direction,
      money: amount,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version,
    };
  }

  private assertValidMovement(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new DomainError("CURRENCY_MISMATCH", "Movement currency differs from wallet");
    }

    if (amount.isZero() || !amount.isPositive()) {
      throw new DomainError("INVALID_MOVEMENT_AMOUNT", "Movement amount must be positive");
    }
  }
}
