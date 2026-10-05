import { DomainError } from "../shared/domain-error";

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
  }): InboxMessage {
    if (!props.messageId || !props.consumerName || !props.payloadHash) {
      throw new DomainError("INVALID_INBOX_MESSAGE", "Inbox identity and payload hash are required");
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      new Date(props.receivedAt.getTime()),
    );
  }

  static rehydrate(state: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt: Date;
    processedAt?: Date;
  }): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt.getTime()),
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new DomainError("INBOX_ALREADY_PROCESSED", "Inbox message is already processed");
    }
    this._processedAt = new Date(at.getTime());
  }
}
