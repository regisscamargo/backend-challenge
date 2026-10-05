import { describe, expect, test } from "bun:test";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { ProcessBetInput, ProcessBetUseCase } from "../../src/application/wagering/process-bet.use-case";
import { SqsWagerTransactionConsumer } from "../../src/infrastructure/messaging/sqs/sqs-wager-transaction.consumer";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";

class FakeSqsClient {
  public deleted = 0;
  public received = 0;

  async send(command: ReceiveMessageCommand | DeleteMessageCommand): Promise<unknown> {
    if (command instanceof ReceiveMessageCommand) {
      this.received += 1;
      return {
        Messages: [{
          Body: JSON.stringify({
            messageId: "message-1",
            type: "WagerTransactionRequested",
            occurredAt: "2026-10-03T12:00:00.000Z",
            data: {
              providerId: "provider-a",
              externalTransactionId: "external-1",
              idempotencyKey: "provider-a:external-1",
              playerId: "player-1",
              walletId: "wallet-1",
              roundId: "round-1",
              gameId: "game-1",
              kind: "BET",
              money: { amount: "25.00", currency: "BRL" },
            },
          }),
          ReceiptHandle: "receipt-1",
        }],
      };
    }

    if (command instanceof DeleteMessageCommand) {
      this.deleted += 1;
      return {};
    }

    throw new Error("unexpected command");
  }
}

describe("SqsWagerTransactionConsumer", () => {
  test("passes the message to the use case and deletes it after success", async () => {
    const client = new FakeSqsClient();
    let captured: ProcessBetInput | undefined;
    const processBet = {
      execute: async (input: ProcessBetInput) => {
        captured = input;
        return {
          transactionId: "transaction-1",
          status: WagerTransactionStatus.Processed,
          idempotentReplay: false,
        };
      },
    } as unknown as ProcessBetUseCase;

    const consumer = new SqsWagerTransactionConsumer(
      client as never,
      "http://localhost:4566/queue",
      processBet,
      { consumerName: "wager-processor", now: () => new Date("2026-10-03T12:01:00.000Z") },
    );

    expect(await consumer.pollOnce()).toBe(1);
    expect(client.received).toBe(1);
    expect(client.deleted).toBe(1);
    expect(captured?.inbox?.messageId).toBe("message-1");
    expect(captured?.inbox?.consumerName).toBe("wager-processor");
    expect(captured?.money.toString()).toBe("25.00");
    expect(captured?.payloadHash).toHaveLength(64);
  });

  test("does not delete a message when the database use case fails", async () => {
    const client = new FakeSqsClient();
    const processBet = {
      execute: async () => { throw new Error("database unavailable"); },
    } as unknown as ProcessBetUseCase;
    const consumer = new SqsWagerTransactionConsumer(
      client as never,
      "http://localhost:4566/queue",
      processBet,
      { consumerName: "wager-processor" },
    );

    await expect(consumer.pollOnce()).rejects.toThrow("database unavailable");
    expect(client.deleted).toBe(0);
  });
});
