import { SendMessageBatchCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { BatchPublishResult, EventPublisher } from "../../../application/outbox/publisher-ports";
import { OutboxMessage } from "../../../domain/outbox/outbox-message";

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
      { abortSignal: AbortSignal.timeout(5_000) },
    );
  }

  async publishBatch(messages: readonly OutboxMessage[]): Promise<BatchPublishResult> {
    if (messages.length === 0 || messages.length > 10) throw new Error("SQS_BATCH_SIZE_MUST_BE_1_TO_10");
    if (new Set(messages.map(message => message.aggregateId)).size !== messages.length) {
      throw new Error("SQS_BATCH_MUST_CONTAIN_DISTINCT_AGGREGATES");
    }

    const response = await this.client.send(new SendMessageBatchCommand({
      QueueUrl: this.queueUrl,
      Entries: messages.map(message => ({
        Id: message.id,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      })),
    }), { abortSignal: AbortSignal.timeout(5_000) });

    const publishedMessageIds = (response.Successful ?? []).flatMap(entry => entry.Id ? [entry.Id] : []);
    const failures = (response.Failed ?? []).flatMap(entry => entry.Id
      ? [{ messageId: entry.Id, reason: [entry.Code, entry.Message].filter(Boolean).join(": ") || "SQS rejected the message" }]
      : []);
    const accountedFor = new Set([...publishedMessageIds, ...failures.map(failure => failure.messageId)]);
    for (const message of messages) {
      if (!accountedFor.has(message.id)) failures.push({ messageId: message.id, reason: "SQS batch response omitted this entry" });
    }
    return { publishedMessageIds, failures };
  }
}
