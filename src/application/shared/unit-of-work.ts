export interface TransactionContext {
  readonly transactionId: string;
  /** Infrastructure-owned transaction handle; application code treats it as opaque. */
  readonly transaction?: unknown;
}

export interface UnitOfWork {
  execute<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>;
}
