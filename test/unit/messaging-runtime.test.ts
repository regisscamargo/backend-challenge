import { expect, test } from "bun:test";
import { MessagingRuntime } from "../../src/infrastructure/messaging/sqs/messaging-runtime";
import { SqsWagerTransactionConsumer } from "../../src/infrastructure/messaging/sqs/sqs-wager-transaction.consumer";
import { PublishOutboxUseCase } from "../../src/application/outbox/publish-outbox.use-case";

test("runtime starts once and drains an in-flight publication before shutdown", async () => {
  let finishConsumer!: () => void;
  let finishPublish!: () => void;
  let started = 0;
  let published = 0;
  const consumer = {
    start: () => { started++; return new Promise<void>((resolve) => { finishConsumer = resolve; }); },
    stop: () => finishConsumer(),
  } as unknown as SqsWagerTransactionConsumer;
  const publisher = {
    execute: () => { published++; return new Promise<{ published: number }>((resolve) => { finishPublish = () => resolve({ published: 0 }); }); },
  } as unknown as PublishOutboxUseCase;
  const runtime = new MessagingRuntime(consumer, publisher, () => {});
  runtime.start(); runtime.start();
  let stopped = false;
  const shutdown = runtime.beforeApplicationShutdown().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finishPublish();
  await shutdown;
  expect(started).toBe(1);
  expect(published).toBe(1);
  expect(stopped).toBe(true);
});

test("runtime immediately requests another outbox page while messages were published", async () => {
  let finishConsumer!: () => void;
  let calls = 0;
  const consumer = {
    start: () => new Promise<void>((resolve) => { finishConsumer = resolve; }),
    stop: () => finishConsumer(),
  } as unknown as SqsWagerTransactionConsumer;
  const publisher = {
    execute: async () => ({ claimed: 1, published: ++calls === 1 ? 1 : 0, scheduledForRetry: 0 }),
  } as unknown as PublishOutboxUseCase;
  const runtime = new MessagingRuntime(consumer, publisher, () => {});

  runtime.start();
  const deadline = Date.now() + 1_000;
  while (calls < 2 && Date.now() < deadline) await Bun.sleep(5);
  await runtime.beforeApplicationShutdown();

  expect(calls).toBe(2);
});
