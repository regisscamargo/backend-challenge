import { InboxMessage } from "../../domain/inbox/inbox-message";
import { TransactionContext } from "../shared/unit-of-work";

export interface InboxRepository {
  find(
    consumerName: string,
    messageId: string,
    context: TransactionContext,
  ): Promise<InboxMessage | null>;

  insert(message: InboxMessage, context: TransactionContext): Promise<void>;
  save(message: InboxMessage, context: TransactionContext): Promise<void>;
}
