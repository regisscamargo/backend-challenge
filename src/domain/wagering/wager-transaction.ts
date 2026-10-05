import { Money, MoneyProps } from "../money/money";
import { DomainError } from "../shared/domain-error";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldCreateNegativeBalance = "REVERSAL_WOULD_CREATE_NEGATIVE_BALANCE",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceTimeout = "REFERENCE_TIMEOUT",
  InvalidReference = "INVALID_REFERENCE",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  IdempotencyConflict = "IDEMPOTENCY_CONFLICT",
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  responseBalance?: Money;
  referenceAttempts?: number;
  referenceNextAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _responseBalance?: Money,
    private _referenceAttempts = 0,
    private _referenceNextAttemptAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainError("OPENING_IS_INTERNAL", "Opening cannot be submitted externally");
    }

    if (!props.id || !props.providerId || !props.externalTransactionId || !props.idempotencyKey) {
      throw new DomainError("INVALID_TRANSACTION_IDENTITY", "Transaction identity is required");
    }

    if (!props.money.isPositive() || props.money.isZero()) {
      throw new DomainError("INVALID_TRANSACTION_AMOUNT", "Transaction amount must be positive");
    }

    const requiresReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;

    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new DomainError("REFERENCE_REQUIRED", "This transaction kind requires a reference");
    }

    if (
      !requiresReference &&
      props.referenceExternalTransactionId &&
      props.kind !== WagerTransactionKind.Win
    ) {
      throw new DomainError("REFERENCE_NOT_ALLOWED", "This transaction kind cannot have a reference");
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt.getTime()),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
    );
  }

  static opening(props: {
    id: string; walletId: string; playerId: string; money: Money; payloadHash: string; now: Date;
  }): WagerTransaction {
    if (!props.id || !props.walletId || !props.playerId || !props.money.isPositive() || props.money.isZero()) {
      throw new DomainError("INVALID_OPENING", "Opening requires identity and a positive amount");
    }
    return new WagerTransaction(
      props.id, "internal:wallet-opening", `opening:${props.walletId}`, `opening:${props.walletId}`,
      props.payloadHash, props.walletId, props.playerId, `opening:${props.walletId}`, "internal",
      WagerTransactionKind.Opening, props.money, undefined, new Date(props.now.getTime()),
      WagerTransactionStatus.Processed, undefined, undefined, new Date(props.now.getTime()), props.money,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt.getTime()),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
      state.responseBalance,
      state.referenceAttempts ?? 0,
      state.referenceNextAttemptAt ? new Date(state.referenceNextAttemptAt.getTime()) : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  get responseBalance(): Money | undefined {
    return this._responseBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get referenceNextAttemptAt(): Date | undefined {
    return this._referenceNextAttemptAt ? new Date(this._referenceNextAttemptAt.getTime()) : undefined;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    responseBalance?: Money,
  ): void {
    this.assertNonTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at.getTime());
    this._responseBalance = responseBalance;
  }

  markPendingReference(at: Date): void {
    this.assertNonTerminal();
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    const delayMs = Math.min(60_000, 2 ** this._referenceAttempts * 1_000);
    this._referenceNextAttemptAt = new Date(at.getTime() + delayMs);
  }

  reject(code: FailureCode, responseBalance?: Money): void {
    this.assertNonTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._responseBalance = responseBalance;
  }

  fail(code: FailureCode): void {
    this.assertNonTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): "DEBIT" | "CREDIT" {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return "DEBIT";
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return "CREDIT";
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new DomainError("REFERENCE_REQUIRED", "Rollback direction needs a reference");
        }
        return reference.ledgerDirectionFor() === "DEBIT" ? "CREDIT" : "DEBIT";
      case WagerTransactionKind.Loss:
        throw new DomainError("LOSS_HAS_NO_LEDGER", "LOSS does not affect the balance");
      case WagerTransactionKind.Opening:
        return "CREDIT";
    }
  }

  private assertNonTerminal(): void {
    if (this.isTerminal()) {
      throw new DomainError(
        "INVALID_TRANSACTION_STATE",
        "Terminal wager transaction cannot transition",
      );
    }
  }
}

export function moneyProps(money: Money): MoneyProps {
  return money.toJSON();
}
