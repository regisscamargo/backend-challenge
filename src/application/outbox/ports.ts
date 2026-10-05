import { OutboxMessage } from "../../domain/outbox/outbox-message";
import { TransactionContext } from "../shared/unit-of-work";

export interface OutboxRepository {
  insert(message: OutboxMessage, context: TransactionContext): Promise<void>;
}
