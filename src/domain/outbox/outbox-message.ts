import { IntegrationEvent } from "../events/integration-event";

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: {
    id: string;
    aggregateId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: Date;
    attempts: number;
    nextAttemptAt?: Date;
    publishedAt?: Date;
  }): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      new Date(state.occurredAt.getTime()),
      state.attempts,
      state.nextAttemptAt ? new Date(state.nextAttemptAt.getTime()) : undefined,
      state.publishedAt ? new Date(state.publishedAt.getTime()) : undefined,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt.getTime()) : undefined;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt.getTime()) : undefined;
  }

  isPending(): boolean {
    return !this._publishedAt;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new Error("OUTBOX_ALREADY_PUBLISHED");
    }
    this._publishedAt = new Date(at.getTime());
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new Error("OUTBOX_ALREADY_PUBLISHED");
    }
    this._attempts += 1;
    const delaySeconds = Math.min(60 * 60, 2 ** this._attempts);
    this._nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);
  }
}
