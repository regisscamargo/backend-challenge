import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import ormConfig from "../../mikro-orm.config";
import { createTestSqsClient } from "../support/test-sqs-client";
import type { CrashJob } from "../support/crash-worker";
import { Worker } from "../support/worker-harness";
import { CreateWalletUseCase } from "../../src/application/wallet/create-wallet.use-case";
import { Money } from "../../src/domain/money/money";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm/mikro-orm-unit-of-work";
import { MikroOrmWalletRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wallet.repository";
import { MikroOrmWagerTransactionRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmLedgerRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-ledger.repository";
import { MikroOrmOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-outbox.repository";
import { MikroOrmPublishableOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-publishable-outbox.repository";
import { WalletOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wallet.orm-entity";
import { WagerTransactionOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wager-transaction.orm-entity";
import { LedgerEntryOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/ledger-entry.orm-entity";
import { InboxMessageOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/inbox-message.orm-entity";
import { OutboxMessageOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/outbox-message.orm-entity";
import { cleanupWithTriggersDisabled } from "../support/database-cleanup";

const consumerName = `crash-${randomUUID()}`;
const walletIds: string[] = [];
const queues: string[] = [];
const workers: Worker[] = [];
const client = createTestSqsClient(1);
let orm: MikroORM;
beforeAll(async () => { orm = await MikroORM.init(ormConfig); });
afterAll(async () => {
  await Promise.all(workers.map(worker => worker.close()));
  try {
    if (orm) {
      try {
        await cleanupWithTriggersDisabled(orm.em, async em => {
          const transactions = await em.find(WagerTransactionOrmEntity, { walletId: { $in: walletIds } });
          await em.nativeDelete(InboxMessageOrmEntity, { consumerName });
          await em.nativeDelete(OutboxMessageOrmEntity, { aggregateId: { $in: [...walletIds, ...transactions.map(tx => tx.id)] } });
          await em.nativeDelete(LedgerEntryOrmEntity, { walletId: { $in: walletIds } });
          await em.nativeDelete(WagerTransactionOrmEntity, { walletId: { $in: walletIds } });
          await em.nativeDelete(WalletOrmEntity, { id: { $in: walletIds } });
        });
      } finally { await orm.close(true); }
    }
  } finally {
    try { for (const url of queues) await client.send(new DeleteQueueCommand({ QueueUrl: url })); }
    finally { client.destroy(); }
  }
});
async function queue(): Promise<string> {
  const response = await client.send(new CreateQueueCommand({ QueueName: `test-crash-${randomUUID()}.fifo`,
    Attributes: { FifoQueue: "true", VisibilityTimeout: "1" } }));
  if (!response.QueueUrl) throw new Error("Missing test queue URL");
  queues.push(response.QueueUrl);
  return response.QueueUrl;
}
function worker(job: CrashJob) {
  const instance = new Worker(job, new URL("../support/crash-worker.ts", import.meta.url));
  workers.push(instance);
  return instance;
}
async function killAtBoundary(victim: Worker) {
  expect(victim.child.exitCode).toBeNull();
  await victim.close();
  expect(victim.child.signalCode).toBe("SIGKILL");
  expect(victim.events.has("closed")).toBe(false);
  expect(victim.events.has("done")).toBe(false);
}
async function queueSize(url: string) {
  const response = await client.send(new GetQueueAttributesCommand({ QueueUrl: url,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
  return Number(response.Attributes?.ApproximateNumberOfMessages ?? "0") +
    Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0");
}

test("SIGKILL after SQL commit leaves a real SQS delivery that a new process ACKs without another debit", async () => {
  const wallet = await new CreateWalletUseCase(new MikroOrmUnitOfWork(orm.em), new MikroOrmWalletRepository(),
    new MikroOrmWagerTransactionRepository(), new MikroOrmLedgerRepository(), new MikroOrmOutboxRepository(),
    { generate: randomUUID }).execute({ playerId: randomUUID(), initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), now: new Date() });
  walletIds.push(wallet.id);
  const url = await queue();
  const messageId = randomUUID();
  const externalTransactionId = randomUUID();
  await client.send(new SendMessageCommand({ QueueUrl: url, MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID(),
    MessageBody: JSON.stringify({ messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { providerId: consumerName, externalTransactionId, idempotencyKey: randomUUID(), playerId: wallet.playerId,
        walletId: wallet.id, roundId: "round", gameId: "game", kind: "BET", money: { amount: "25.00", currency: "BRL" } } }) }));
  const victim = worker({ type: "init", mode: "consumer", queueUrl: url, consumerName, pauseAtBoundary: true });
  try {
    const first = await victim.wait("ready"); victim.send("start");
    const checkpoint = await victim.wait("committed");
    const original = checkpoint.results![0]!;
    expect(original.idempotentReplay).toBe(false);
    const assertCommittedState = async () => {
      const em = orm.em.fork();
      const saved = await em.findOneOrFail(WalletOrmEntity, { id: wallet.id });
      expect(saved.balance).toBe("75.00");
      expect(saved.version).toBe(2);
      const transactions = await em.find(WagerTransactionOrmEntity, { walletId: wallet.id, kind: "BET" });
      expect(transactions).toHaveLength(1);
      expect(transactions[0]!.id).toBe(original.transactionId);
      expect(await em.count(LedgerEntryOrmEntity, { walletId: wallet.id, direction: "DEBIT" })).toBe(1);
      expect(await em.count(InboxMessageOrmEntity, { consumerName, messageId, processedAt: { $ne: null } })).toBe(1);
      const ids = await em.find(WagerTransactionOrmEntity, { walletId: wallet.id });
      expect(await em.count(OutboxMessageOrmEntity, { aggregateId: { $in: [wallet.id, ...ids.map(tx => tx.id)] } })).toBe(4);
    };
    await assertCommittedState();
    expect(await queueSize(url)).toBe(1);
    await killAtBoundary(victim);
    await assertCommittedState();
    const recovery = worker({ type: "init", mode: "consumer", queueUrl: url, consumerName, pauseAtBoundary: false });
    const second = await recovery.wait("ready");
    expect(second.pid).not.toBe(first.pid);
    recovery.send("start");
    const done = await recovery.wait("done");
    expect(await recovery.child.exited).toBe(0);
    expect(done.results).toHaveLength(1);
    expect(done.results![0]!.transactionId).toBe(original.transactionId);
    expect(done.results![0]!.idempotentReplay).toBe(true);
    expect(done.results![0]!.balance?.amount).toBe("75.00");
    await assertCommittedState();
    expect(await queueSize(url)).toBe(0);
  } finally { await victim.close(); }
}, 25_000);

test("SIGKILL after SQS accepts an event recovers the expired lease and marks a retry of the same event", async () => {
  const schema = `test_crash_${randomUUID().replaceAll("-", "")}`;
  const isolated = await MikroORM.init({ ...ormConfig, schema });
  const localWorkers: Worker[] = [];
  try {
    await isolated.schema.create();
    const url = await queue();
    const eventId = randomUUID();
    const aggregateId = randomUUID();
    await isolated.em.fork().insert(OutboxMessageOrmEntity, {
      id: eventId, aggregateId, eventType: "RecoveryProbe", occurredAt: new Date(), attempts: 0,
      payload: { eventId, aggregateId, eventType: "RecoveryProbe", version: 1, data: {} },
      publishedAt: null, nextAttemptAt: null, lockedAt: null, lockedBy: null, lastError: null,
    });
    const leaseMs = 5_000;
    const victim = worker({ type: "init", mode: "publisher", schema, queueUrl: url, leaseMs, pauseAtBoundary: true });
    localWorkers.push(victim);
    const first = await victim.wait("ready"); victim.send("start");
    expect((await victim.wait("accepted")).eventId).toBe(eventId);
    const received = await client.send(new ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 0 }));
    expect(received.Messages).toHaveLength(1);
    expect(JSON.parse(received.Messages![0]!.Body!).eventId).toBe(eventId);
    await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: received.Messages![0]!.ReceiptHandle! }));
    const checkpoint = await isolated.em.fork().findOneOrFail(OutboxMessageOrmEntity, { id: eventId });
    expect(checkpoint.publishedAt).toBeNull();
    expect(checkpoint.lockedBy).not.toBeNull();
    expect(checkpoint.lockedAt).not.toBeNull();
    await killAtBoundary(victim);
    const repository = new MikroOrmPublishableOutboxRepository(isolated.em, leaseMs);
    expect(await repository.claimDue(new Date(), randomUUID(), 1)).toHaveLength(0);
    const expiresAt = checkpoint.lockedAt!.getTime() + leaseMs;
    const deadline = Date.now() + 10_000;
    while (Date.now() <= expiresAt && Date.now() < deadline) await Bun.sleep(50);
    expect(Date.now()).toBeGreaterThan(expiresAt);
    const recovery = worker({ type: "init", mode: "publisher", schema, queueUrl: url, leaseMs, pauseAtBoundary: false });
    localWorkers.push(recovery);
    const second = await recovery.wait("ready");
    expect(second.pid).not.toBe(first.pid);
    recovery.send("start");
    const done = await recovery.wait("done");
    expect(await recovery.child.exited).toBe(0);
    expect(recovery.events.get("accepted")!.eventId).toBe(eventId);
    expect(done.attempted).toEqual([eventId]);
    expect(done.result).toEqual({ claimed: 1, published: 1, scheduledForRetry: 0 });
    const saved = await isolated.em.fork().findOneOrFail(OutboxMessageOrmEntity, { id: eventId });
    expect(saved.publishedAt).not.toBeNull();
    expect(saved.lockedAt).toBeNull();
    expect(saved.lockedBy).toBeNull();
    expect(saved.attempts).toBe(0); // Crash is not a caught failure scheduled by the publisher.
    expect(await isolated.em.fork().count(OutboxMessageOrmEntity, {})).toBe(1);
    // Two acknowledged SendMessage calls are proved by IPC. FIFO may suppress the
    // second delivery within its deduplication window; that is not exactly-once.
  } finally {
    await Promise.all(localWorkers.map(instance => instance.close()));
    try { await isolated.schema.drop({ schema }); await isolated.schema.dropNamespace(schema); }
    finally { await isolated.close(true); }
  }
}, 25_000);
