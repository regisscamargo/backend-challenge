import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { ProcessBetInput, ProcessBetUseCase } from "../../../application/wagering/process-bet.use-case";
import { hashCanonicalPayload } from "../../../application/wagering/payload-hash";
import { Money } from "../../../domain/money/money";
import { WagerTransactionKind } from "../../../domain/wagering/wager-transaction";

interface WagerTransactionRequested {
  messageId: string;
  type: "WagerTransactionRequested";
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    referenceExternalTransactionId?: string;
    money: { amount: string; currency: string };
  };
}

export interface SqsWagerTransactionConsumerOptions {
  consumerName: string;
  visibilityTimeoutSeconds?: number;
  waitTimeSeconds?: number;
  maxNumberOfMessages?: number;
  now?: () => Date;
  onFailure?: () => void;
}

/**
 * SQS adapter: the receipt is deleted only after the database use case has
 * committed. Any thrown error intentionally leaves the message invisible
 * until SQS redelivers it or moves it to the configured DLQ.
 */
export class SqsWagerTransactionConsumer {
  private stopping = false;
  private receiving: AbortController | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly processBet: ProcessBetUseCase,
    private readonly options: SqsWagerTransactionConsumerOptions,
  ) {}

  async pollOnce(): Promise<number> {
    this.receiving = new AbortController();
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: this.options.maxNumberOfMessages ?? 1,
        WaitTimeSeconds: this.options.waitTimeSeconds ?? 10,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds ?? 30,
        MessageAttributeNames: ["All"],
      }),
      { abortSignal: this.receiving.signal },
    );
    this.receiving = undefined;

    const messages = response.Messages ?? [];
    for (const message of messages) {
      if (!message.Body || !message.ReceiptHandle) {
        continue;
      }

      const envelope = parseMessage(message.Body);
      const input = toProcessBetInput(
        envelope,
        this.options.consumerName,
        this.options.now?.() ?? new Date(),
      );

      await this.processBet.execute(input);

      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }

    return messages.length;
  }

  async start(): Promise<void> {
    this.stopping = false;
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch {
        if (this.stopping) break;
        this.options.onFailure?.();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          this.wake = () => { clearTimeout(timer); resolve(); };
        });
        this.wake = undefined;
      }
    }
  }

  stop(): void {
    this.stopping = true;
    this.receiving?.abort();
    this.wake?.();
  }
}

function parseMessage(body: string): WagerTransactionRequested {
  const parsed: unknown = JSON.parse(body);
  if (!isWagerTransactionRequested(parsed)) {
    throw new Error("INVALID_WAGER_TRANSACTION_MESSAGE");
  }
  return parsed;
}

function toProcessBetInput(
  message: WagerTransactionRequested,
  consumerName: string,
  now: Date,
): ProcessBetInput {
  const { idempotencyKey: _idempotencyKey, ...businessPayload } = message.data;
  const input: ProcessBetInput = {
    ...message.data,
    money: Money.from(message.data.money),
    payloadHash: hashCanonicalPayload(businessPayload),
    now,
    inbox: {
      messageId: message.messageId,
      consumerName,
      receivedAt: now,
    },
  };
  return input;
}

function isWagerTransactionRequested(value: unknown): value is WagerTransactionRequested {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const data = candidate.data;
  if (!data || typeof data !== "object") return false;
  const transaction = data as Record<string, unknown>;

  return (
    candidate.type === "WagerTransactionRequested" &&
    typeof candidate.messageId === "string" &&
    typeof candidate.occurredAt === "string" &&
    typeof transaction.providerId === "string" &&
    typeof transaction.externalTransactionId === "string" &&
    typeof transaction.idempotencyKey === "string" &&
    typeof transaction.playerId === "string" &&
    typeof transaction.walletId === "string" &&
    typeof transaction.roundId === "string" &&
    typeof transaction.gameId === "string" &&
    Object.values(WagerTransactionKind).includes(transaction.kind as WagerTransactionKind) &&
    isMoney(transaction.money)
  );
}

function isMoney(value: unknown): value is { amount: string; currency: string } {
  if (!value || typeof value !== "object") return false;
  const money = value as Record<string, unknown>;
  return typeof money.amount === "string" && /^(?:0|[1-9]\d{0,12})\.\d{2}$/.test(money.amount) &&
    typeof money.currency === "string" && /^[A-Z]{3}$/.test(money.currency);
}
