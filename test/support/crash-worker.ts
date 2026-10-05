import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQSClient } from "@aws-sdk/client-sqs";
import ormConfig from "../../mikro-orm.config";
import { createTestSqsClient } from "./test-sqs-client";
import { ProcessBetInput, ProcessBetUseCase } from "../../src/application/wagering/process-bet.use-case";
import { PublishOutboxUseCase } from "../../src/application/outbox/publish-outbox.use-case";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm/mikro-orm-unit-of-work";
import { MikroOrmWalletRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wallet.repository";
import { MikroOrmWagerTransactionRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmLedgerRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-ledger.repository";
import { MikroOrmOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-outbox.repository";
import { MikroOrmInboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-inbox.repository";
import { MikroOrmPublishableOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-publishable-outbox.repository";
import { SqsWagerTransactionConsumer } from "../../src/infrastructure/messaging/sqs/sqs-wager-transaction.consumer";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs/sqs-event.publisher";

export type CrashJob = { type: "init"; queueUrl: string; pauseAtBoundary: boolean } & (
  { mode: "consumer"; consumerName: string } |
  { mode: "publisher"; schema: string; leaseMs: number }
);
const commands = new Map<string, unknown>();
const waiting = new Map<string, (value: unknown) => void>();
process.on("message", (value: unknown) => {
  const command = value as { type: string };
  const resolve = waiting.get(command.type);
  if (resolve) { waiting.delete(command.type); resolve(value); }
  else commands.set(command.type, value);
});
function receive(type: string): Promise<unknown> {
  if (commands.has(type)) { const value = commands.get(type); commands.delete(type); return Promise.resolve(value); }
  return new Promise(resolve => waiting.set(type, resolve));
}
function emit(type: string, data: Record<string, unknown> = {}): void {
  process.send?.({ type, pid: process.pid, ...data });
}

let orm: MikroORM | undefined;
let client: SQSClient | undefined;
try {
  const job = await receive("init") as CrashJob;
  orm = await MikroORM.init({ ...ormConfig, ...(job.mode === "publisher" ? { schema: job.schema } : {}) });
  client = createTestSqsClient(1);
  emit("ready");
  await receive("start");
  if (job.mode === "consumer") {
    const delegate = new ProcessBetUseCase(new MikroOrmUnitOfWork(orm.em), new MikroOrmWagerTransactionRepository(),
      new MikroOrmWalletRepository(), new MikroOrmLedgerRepository(), new MikroOrmOutboxRepository(),
      { generate: randomUUID }, new MikroOrmInboxRepository());
    const results: unknown[] = [];
    const wrapped = { execute: async (input: ProcessBetInput) => {
      const result = await delegate.execute(input); // SQL transaction has already committed.
      const wire = { ...result, balance: result.balance?.toJSON() };
      results.push(wire);
      if (job.pauseAtBoundary) {
        emit("committed", { results: [wire] });
        await receive("continue"); // Parent kills this process here, before DeleteMessage.
      }
      return result;
    } } as unknown as ProcessBetUseCase;
    const consumer = new SqsWagerTransactionConsumer(client, job.queueUrl, wrapped,
      { consumerName: job.consumerName, visibilityTimeoutSeconds: 1, waitTimeSeconds: 0 });
    let deliveries = 0;
    const deadline = Date.now() + 10_000;
    while (deliveries === 0 && Date.now() < deadline) {
      deliveries = await consumer.pollOnce();
      if (deliveries === 0) await Bun.sleep(50);
    }
    if (deliveries !== 1) throw new Error("Expected one real SQS delivery");
    emit("done", { results }); // DeleteMessage has completed.
  } else {
    const delegate = new SqsEventPublisher(client, job.queueUrl);
    const attempted: string[] = [];
    const publisher = new PublishOutboxUseCase(new MikroOrmPublishableOutboxRepository(orm.em, job.leaseMs), {
      publish: async message => {
        attempted.push(message.id);
        await delegate.publish(message); // SQS has acknowledged SendMessage.
        emit("accepted", { eventId: message.id });
        if (job.pauseAtBoundary) await receive("continue"); // Before markPublished.
      },
    });
    const result = await publisher.execute(new Date(), 1);
    emit("done", { result, attempted });
  }
} catch (error) {
  emit("failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await orm?.close(true);
  client?.destroy();
  emit("closed");
  process.disconnect?.();
}
