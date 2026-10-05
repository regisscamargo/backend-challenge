import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LockMode } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import ormConfig from "../../mikro-orm.config";
import { createTestSqsClient } from "../support/test-sqs-client";
import type { WireInput } from "../support/concurrency-worker";
import { Worker } from "../support/worker-harness";
import { CreateWalletUseCase } from "../../src/application/wallet/create-wallet.use-case";
import { PublishOutboxUseCase } from "../../src/application/outbox/publish-outbox.use-case";
import { Money } from "../../src/domain/money/money";
import { hashCanonicalPayload } from "../../src/application/wagering/payload-hash";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm/mikro-orm-unit-of-work";
import { MikroOrmWalletRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wallet.repository";
import { MikroOrmWagerTransactionRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmLedgerRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-ledger.repository";
import { MikroOrmOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-outbox.repository";
import { MikroOrmPublishableOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-publishable-outbox.repository";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs/sqs-event.publisher";
import { WalletOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wallet.orm-entity";
import { WagerTransactionOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wager-transaction.orm-entity";
import { LedgerEntryOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/ledger-entry.orm-entity";
import { InboxMessageOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/inbox-message.orm-entity";
import { OutboxMessageOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/outbox-message.orm-entity";
import { cleanupWithTriggersDisabled } from "../support/database-cleanup";

let orm: MikroORM;
const walletIds: string[] = [];
const consumerName = `concurrent-${randomUUID()}`;
beforeAll(async () => { orm = await MikroORM.init(ormConfig); });
afterAll(async () => {
  if (!orm) return;
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
});
async function createWallet(database = orm) {
  return new CreateWalletUseCase(new MikroOrmUnitOfWork(database.em), new MikroOrmWalletRepository(),
    new MikroOrmWagerTransactionRepository(), new MikroOrmLedgerRepository(), new MikroOrmOutboxRepository(),
    { generate: randomUUID }).execute({ playerId: randomUUID(), initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), now: new Date() });
}
function input(wallet: { id: string; playerId: string }, amount: string): WireInput {
  const data = { providerId: consumerName, externalTransactionId: randomUUID(), walletId: wallet.id,
    playerId: wallet.playerId, roundId: "round", gameId: "game", money: { amount, currency: "BRL" } };
  return { ...data, idempotencyKey: randomUUID(), payloadHash: hashCanonicalPayload(data),
    inbox: { consumerName, messageId: randomUUID() } };
}
async function compete(walletId: string, inputs: WireInput[]) {
  const workers = Array.from({ length: 3 }, (_, index) => new Worker({ type: "init", mode: "financial",
    inputs: inputs.filter((_, position) => position % 3 === index) }));
  try {
    const ready = await Promise.all(workers.map(worker => worker.wait("ready")));
    expect(new Set(ready.map(event => event.pid)).size).toBe(3);
    expect(ready.every(event => event.pid !== process.pid)).toBe(true);
    // Keep the wallet locked until all three processes have an active SQL transaction.
    await orm.em.fork().transactional(async em => {
      await em.findOneOrFail(WalletOrmEntity, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      workers.forEach(worker => worker.send("start"));
      await Promise.all(workers.map(worker => worker.wait("started")));
    });
    const done = await Promise.all(workers.map(worker => worker.wait("done")));
    expect(await Promise.all(workers.map(worker => worker.child.exited))).toEqual([0, 0, 0]);
    return done.flatMap(event => event.results!);
  } finally { await Promise.all(workers.map(worker => worker.close())); }
}
async function assertBalanceFromLedger(walletId: string, expected: string, entries: number) {
  const em = orm.em.fork();
  const wallet = await em.findOneOrFail(WalletOrmEntity, { id: walletId });
  const ledger = await em.find(LedgerEntryOrmEntity, { walletId });
  let sum = Money.zero("BRL");
  for (const entry of ledger) {
    const amount = Money.from({ amount: entry.amount, currency: entry.currency });
    sum = entry.direction === "CREDIT" ? sum.add(amount) : sum.subtract(amount);
    expect(Money.from({ amount: entry.balanceAfter, currency: entry.currency }).isNegative()).toBe(false);
  }
  expect(sum.toString()).toBe(expected);
  expect(wallet.balance).toBe(expected);
  expect(ledger).toHaveLength(entries);
}

test("three processes competing for funds persist ten debits and five rejections", async () => {
  const wallet = await createWallet(); walletIds.push(wallet.id);
  const results = await compete(wallet.id, Array.from({ length: 15 }, () => input(wallet, "10.00")));
  expect(results.filter(result => result.status === "PROCESSED")).toHaveLength(10);
  expect(results.filter(result => result.status === "REJECTED")).toHaveLength(5);
  expect(results.every(result => !result.idempotentReplay)).toBe(true);
  const em = orm.em.fork();
  expect(await em.count(WagerTransactionOrmEntity, { walletId: wallet.id, kind: "BET" })).toBe(15);
  expect(await em.count(WagerTransactionOrmEntity, { walletId: wallet.id, status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" })).toBe(5);
  const transactions = await em.find(WagerTransactionOrmEntity, { walletId: wallet.id });
  expect(await em.count(OutboxMessageOrmEntity, { aggregateId: { $in: [wallet.id, ...transactions.map(tx => tx.id)] } })).toBe(27);
  expect(await em.count(InboxMessageOrmEntity, { consumerName, processedAt: { $ne: null } })).toBe(15);
  expect((await em.findOneOrFail(WalletOrmEntity, { id: wallet.id })).version).toBe(11);
  await assertBalanceFromLedger(wallet.id, "0.00", 11);
}, 30_000);

test("fifty concurrent copies across three processes return one original result", async () => {
  const wallet = await createWallet(); walletIds.push(wallet.id);
  const request = input(wallet, "25.00");
  const results = await compete(wallet.id, Array.from({ length: 50 }, () => request));
  expect(results).toHaveLength(50);
  expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
  expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
  expect(results.filter(result => result.idempotentReplay)).toHaveLength(49);
  expect(results.every(result => result.status === "PROCESSED" && result.balance?.amount === "75.00")).toBe(true);
  const em = orm.em.fork();
  expect(await em.count(WagerTransactionOrmEntity, { walletId: wallet.id, kind: "BET" })).toBe(1);
  expect(await em.count(InboxMessageOrmEntity, { ...request.inbox, processedAt: { $ne: null } })).toBe(1);
  expect((await em.findOneOrFail(WalletOrmEntity, { id: wallet.id })).version).toBe(2);
  const ids = await em.find(WagerTransactionOrmEntity, { walletId: wallet.id });
  expect(await em.count(OutboxMessageOrmEntity, { aggregateId: { $in: [wallet.id, ...ids.map(tx => tx.id)] } })).toBe(4);
  await assertBalanceFromLedger(wallet.id, "75.00", 2);
}, 30_000);

test("three processes update distinct wallets independently and preserve every ledger", async () => {
  const wallets = await Promise.all(Array.from({ length: 12 }, () => createWallet()));
  walletIds.push(...wallets.map(wallet => wallet.id));
  const results = await compete(wallets[0]!.id, wallets.map(wallet => input(wallet, "10.00")));
  expect(results).toHaveLength(12);
  expect(results.every(result => result.status === "PROCESSED" && !result.idempotentReplay)).toBe(true);
  expect(new Set(results.map(result => result.transactionId)).size).toBe(12);
  for (const wallet of wallets) await assertBalanceFromLedger(wallet.id, "90.00", 2);
}, 30_000);

test("outbox claims preserve per-aggregate order across publisher workers", async () => {
  const schema = `test_outbox_order_${randomUUID().replaceAll("-", "")}`;
  const isolated = await MikroORM.init({ ...ormConfig, schema });
  const aggregateId = randomUUID();
  const firstId = randomUUID();
  const secondId = randomUUID();
  const independentAggregateId = randomUUID();
  try {
    await isolated.schema.create();
    const em = isolated.em.fork();
    em.persist([
      em.create(OutboxMessageOrmEntity, {
        id: firstId, aggregateId, eventType: "Ordered", payload: { eventId: firstId, data: { walletVersion: 1 } },
        occurredAt: new Date("2026-10-03T12:00:01.000Z"), attempts: 0, nextAttemptAt: null,
        publishedAt: null, lockedAt: null, lockedBy: null, lastError: null,
      }, { partial: true }),
      em.create(OutboxMessageOrmEntity, {
        id: secondId, aggregateId, eventType: "Ordered", payload: { eventId: secondId, data: { walletVersion: 2 } },
        occurredAt: new Date("2026-10-03T12:00:00.000Z"), attempts: 0, nextAttemptAt: null,
        publishedAt: null, lockedAt: null, lockedBy: null, lastError: null,
      }, { partial: true }),
      em.create(OutboxMessageOrmEntity, {
        id: randomUUID(), aggregateId: independentAggregateId, eventType: "Independent",
        payload: {}, occurredAt: new Date("2026-10-03T12:00:02.000Z"), attempts: 0,
        nextAttemptAt: null, publishedAt: null, lockedAt: null, lockedBy: null, lastError: null,
      }, { partial: true }),
    ]);
    await em.flush();

    const repository = new MikroOrmPublishableOutboxRepository(isolated.em);
    const firstWorker = await repository.claimDue(new Date("2026-10-03T12:01:00.000Z"), "worker-one", 10);
    expect(firstWorker.map(message => message.id)).toContain(firstId);
    expect(firstWorker.map(message => message.id)).not.toContain(secondId);

    const secondWorker = await repository.claimDue(new Date("2026-10-03T12:01:00.000Z"), "worker-two", 10);
    expect(secondWorker.map(message => message.id)).not.toContain(secondId);

    await repository.markPublished(firstId, "worker-one", new Date("2026-10-03T12:01:01.000Z"));
    const nextClaim = await repository.claimDue(new Date("2026-10-03T12:01:02.000Z"), "worker-two", 10);
    expect(nextClaim.map(message => message.id)).toContain(secondId);
  } finally {
    try { await isolated.schema.drop({ schema }); await isolated.schema.dropNamespace(schema); }
    finally { await isolated.close(true); }
  }
}, 30_000);

test("two publisher processes skip locked events and claim disjoint batches", async () => {
  const schema = `test_publish_${randomUUID().replaceAll("-", "")}`;
  const isolated = await MikroORM.init({ ...ormConfig, schema });
  const client = createTestSqsClient();
  const workers: Worker[] = [];
  let queueUrl: string | undefined;
  try {
    await isolated.schema.create();
    for (let index = 0; index < 6; index++) await createWallet(isolated);
    queueUrl = (await client.send(new CreateQueueCommand({ QueueName: `test-publish-${randomUUID()}.fifo`, Attributes: { FifoQueue: "true" } }))).QueueUrl!;
    const allEvents = await isolated.em.fork().find(OutboxMessageOrmEntity, {}, { orderBy: { occurredAt: "ASC" } });
    expect(allEvents).toHaveLength(12);
    workers.push(...Array.from({ length: 2 }, () => new Worker({ type: "init", mode: "publisher", schema, queueUrl: queueUrl! })));
    const ready = await Promise.all(workers.map(worker => worker.wait("ready")));
    expect(new Set(ready.map(event => event.pid)).size).toBe(2);
    const heldIds = allEvents.slice(0, 2).map(event => event.id);
    let attempted: string[] = [];
    await isolated.em.fork().transactional(async em => {
      await em.find(OutboxMessageOrmEntity, { id: { $in: heldIds } }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      workers.forEach(worker => worker.send("start"));
      await Promise.all(workers.map(worker => worker.wait("claimed")));
      const claimed = await isolated.em.fork().find(OutboxMessageOrmEntity, { lockedBy: { $ne: null } });
      expect(claimed).toHaveLength(10);
      expect(new Set(claimed.map(event => event.lockedBy)).size).toBe(2);
      expect(claimed.every(event => !heldIds.includes(event.id))).toBe(true);
      workers.forEach(worker => worker.send("publish"));
      const done = await Promise.all(workers.map(worker => worker.wait("done")));
      for (const event of done) expect(event.result).toEqual({ claimed: 5, published: 5, scheduledForRetry: 0 });
      attempted = done.flatMap(event => event.attempted!);
      expect(attempted).toHaveLength(10);
      expect(new Set(attempted).size).toBe(10);
      expect(await isolated.em.fork().count(OutboxMessageOrmEntity, { publishedAt: null })).toBe(2);
    });
    expect(await Promise.all(workers.map(worker => worker.child.exited))).toEqual([0, 0]);
    const final = await new PublishOutboxUseCase(new MikroOrmPublishableOutboxRepository(isolated.em), new SqsEventPublisher(client, queueUrl)).execute(new Date(), 5);
    expect(final).toEqual({ claimed: 2, published: 2, scheduledForRetry: 0 });
    expect(await isolated.em.fork().count(OutboxMessageOrmEntity, { publishedAt: null })).toBe(0);
    const received = new Set<string>();
    const deadline = Date.now() + 8_000;
    while (received.size < 12 && Date.now() < deadline) {
      const batch = await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      for (const message of batch.Messages ?? []) {
        received.add(JSON.parse(message.Body!).eventId);
        await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
      }
    }
    expect(received).toEqual(new Set(allEvents.map(event => event.id)));
  } finally {
    await Promise.all(workers.map(worker => worker.close()));
    try {
      if (queueUrl) await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    } finally {
      client.destroy();
      try { await isolated.schema.drop({ schema }); await isolated.schema.dropNamespace(schema); }
      finally { await isolated.close(true); }
    }
  }
}, 30_000);
