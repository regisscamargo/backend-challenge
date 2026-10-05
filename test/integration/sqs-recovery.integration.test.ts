import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import ormConfig from "../../mikro-orm.config";
import { createTestSqsClient } from "../support/test-sqs-client";
import { CreateWalletUseCase } from "../../src/application/wallet/create-wallet.use-case";
import { ProcessBetUseCase } from "../../src/application/wagering/process-bet.use-case";
import { Money } from "../../src/domain/money/money";
import { SqsWagerTransactionConsumer } from "../../src/infrastructure/messaging/sqs/sqs-wager-transaction.consumer";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs/sqs-event.publisher";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm/mikro-orm-unit-of-work";
import { MikroOrmWalletRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wallet.repository";
import { MikroOrmWagerTransactionRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmLedgerRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-ledger.repository";
import { MikroOrmOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-outbox.repository";
import { MikroOrmInboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-inbox.repository";
import { WalletOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wallet.orm-entity";
import { WagerTransactionOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wager-transaction.orm-entity";
import { LedgerEntryOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/ledger-entry.orm-entity";
import { OutboxMessageOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/outbox-message.orm-entity";
import { InboxMessageOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/inbox-message.orm-entity";
import { OutboxMessageMapper } from "../../src/infrastructure/persistence/mikro-orm/mappers/outbox-message.mapper";
import { MikroOrmPublishableOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-publishable-outbox.repository";
import { PublishOutboxUseCase } from "../../src/application/outbox/publish-outbox.use-case";
import { MessagingRuntime } from "../../src/infrastructure/messaging/sqs/messaging-runtime";
import { cleanupWithTriggersDisabled } from "../support/database-cleanup";

const runId = randomUUID();
const consumerName = `recovery-${runId}`;
const queues: string[] = [];
const walletIds: string[] = [];
const client = createTestSqsClient(1);
let orm: MikroORM;
let processBet: ProcessBetUseCase;

beforeAll(async () => {
  orm = await MikroORM.init(ormConfig);
  processBet = new ProcessBetUseCase(new MikroOrmUnitOfWork(orm.em), new MikroOrmWagerTransactionRepository(),
    new MikroOrmWalletRepository(), new MikroOrmLedgerRepository(), new MikroOrmOutboxRepository(),
    { generate: randomUUID }, new MikroOrmInboxRepository());
});
afterAll(async () => {
  try {
    if (orm) {
      await cleanupWithTriggersDisabled(orm.em, async em => {
        const transactions = await em.find(WagerTransactionOrmEntity, { walletId: { $in: walletIds } });
        await em.nativeDelete(InboxMessageOrmEntity, { consumerName });
        await em.nativeDelete(OutboxMessageOrmEntity, { aggregateId: { $in: [...walletIds, ...transactions.map(tx => tx.id)] } });
        await em.nativeDelete(LedgerEntryOrmEntity, { walletId: { $in: walletIds } });
        await em.nativeDelete(WagerTransactionOrmEntity, { walletId: { $in: walletIds } });
        await em.nativeDelete(WalletOrmEntity, { id: { $in: walletIds } });
      });
      await orm.close(true);
    }
  } finally {
    try { for (const url of queues) await client.send(new DeleteQueueCommand({ QueueUrl: url })); }
    finally { client.destroy(); }
  }
});

async function queue(attributes: Record<string, string> = {}): Promise<string> {
  const response = await client.send(new CreateQueueCommand({ QueueName: `test-${randomUUID()}.fifo`,
    Attributes: { FifoQueue: "true", VisibilityTimeout: "1", ...attributes } }));
  if (!response.QueueUrl) throw new Error("Missing test queue URL");
  queues.push(response.QueueUrl);
  return response.QueueUrl;
}
async function eventually(check: () => Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for SQS recovery evidence");
}
async function fixture() {
  const wallet = await new CreateWalletUseCase(new MikroOrmUnitOfWork(orm.em), new MikroOrmWalletRepository(),
    new MikroOrmWagerTransactionRepository(), new MikroOrmLedgerRepository(), new MikroOrmOutboxRepository(),
    { generate: randomUUID }).execute({ playerId: randomUUID(), initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), now: new Date() });
  walletIds.push(wallet.id);
  const body = JSON.stringify({ messageId: randomUUID(), type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
    data: { providerId: runId, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(),
      playerId: wallet.playerId, walletId: wallet.id, roundId: "round", gameId: "game", kind: "BET",
      money: { amount: "25.00", currency: "BRL" } } });
  return { wallet, body };
}
const consumer = (url: string, useCase = processBet) => new SqsWagerTransactionConsumer(client, url, useCase,
  { consumerName, visibilityTimeoutSeconds: 1, waitTimeSeconds: 0, maxNumberOfMessages: 1 });
async function send(url: string, body: string, group: string) {
  await client.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageGroupId: group, MessageDeduplicationId: randomUUID() }));
}
async function assertSingleDebit(walletId: string) {
  const em = orm.em.fork();
  expect((await em.findOneOrFail(WalletOrmEntity, { id: walletId })).balance).toBe("75.00");
  expect(await em.count(WagerTransactionOrmEntity, { walletId, kind: "BET" })).toBe(1);
  expect(await em.count(LedgerEntryOrmEntity, { walletId, direction: "DEBIT" })).toBe(1);
}

test("real SQS redelivery after commit without ACK replays one financial effect", async () => {
  const url = await queue();
  const { wallet, body } = await fixture();
  await send(url, body, wallet.id);
  let commits = 0;
  const failing = { execute: async (input: Parameters<ProcessBetUseCase["execute"]>[0]) => {
    await processBet.execute(input);
    commits++;
    throw new Error("injected crash boundary: committed, no ACK");
  } } as unknown as ProcessBetUseCase;
  await expect(consumer(url, failing).pollOnce()).rejects.toThrow("no ACK");
  expect(commits).toBe(1);
  await assertSingleDebit(wallet.id);
  let deliveries = 0;
  await eventually(async () => { deliveries += await consumer(url).pollOnce(); return deliveries > 0; });
  await assertSingleDebit(wallet.id);
  expect(await orm.em.fork().count(InboxMessageOrmEntity, { consumerName, messageId: JSON.parse(body).messageId })).toBe(1);
  expect((await client.send(new ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 0 }))).Messages ?? []).toHaveLength(0);
}, 15_000);

test("continuous consumer survives a transient failure and ACKs an explicit duplicate", async () => {
  const url = await queue();
  const { wallet, body } = await fixture();
  let attempts = 0;
  let completed = 0;
  const flaky = { execute: async (input: Parameters<ProcessBetUseCase["execute"]>[0]) => {
    if (++attempts === 1) throw new Error("injected pre-commit transient failure");
    const result = await processBet.execute(input);
    completed++;
    return result;
  } } as unknown as ProcessBetUseCase;
  await send(url, body, wallet.id);
  const worker = consumer(url, flaky);
  const running = worker.start();
  try {
    await eventually(async () => completed === 1);
    await send(url, body, wallet.id); // Distinct SQS dedup ID forces a real second delivery.
    await eventually(async () => completed === 2);
  } finally { worker.stop(); await running; }
  expect(attempts).toBe(3);
  await assertSingleDebit(wallet.id);
}, 15_000);

test("poison message reaches real FIFO DLQ through the queue redrive policy", async () => {
  const dlq = await queue();
  const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ["QueueArn"] }));
  const url = await queue({ RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attributes.Attributes?.QueueArn, maxReceiveCount: "2" }) });
  const body = "not-json";
  await send(url, body, runId);
  let rejected = 0;
  let deadBody: string | undefined;
  await eventually(async () => {
    try { await consumer(url).pollOnce(); } catch { rejected++; }
    const result = await client.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 0 }));
    deadBody = result.Messages?.[0]?.Body;
    return deadBody !== undefined;
  });
  expect(rejected).toBe(2);
  expect(deadBody).toBe(body);
}, 15_000);

test("committed Outbox event is delivered to a separate real FIFO event queue", async () => {
  const url = await queue();
  const { wallet, body } = await fixture();
  const processed = await processBet.execute({ ...JSON.parse(body).data, money: Money.from({ amount: "25.00", currency: "BRL" }),
    payloadHash: "a".repeat(64), now: new Date() });
  const records = await orm.em.fork().find(OutboxMessageOrmEntity,
    { aggregateId: { $in: [wallet.id, processed.transactionId] } }, { orderBy: { occurredAt: "ASC" } });
  const publisher = new SqsEventPublisher(client, url);
  const messages = records.map(OutboxMessageMapper.toDomain);
  const firstPerAggregate = new Map<string, typeof messages[number]>();
  const remaining: typeof messages = [];
  for (const message of messages) {
    if (firstPerAggregate.has(message.aggregateId)) remaining.push(message);
    else firstPerAggregate.set(message.aggregateId, message);
  }
  const batch = [...firstPerAggregate.values()];
  const batchResult = await publisher.publishBatch(batch);
  expect(batchResult.publishedMessageIds).toHaveLength(batch.length);
  expect(batchResult.failures).toHaveLength(0);
  for (const message of remaining) await publisher.publish(message);
  const received = await client.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
  expect(received.Messages).toHaveLength(messages.length);
  expect(new Set(received.Messages?.map(message => JSON.parse(message.Body!).eventId))).toEqual(new Set(records.map(record => record.id)));
  const walletEventOrder = (received.Messages ?? []).map(message => JSON.parse(message.Body!))
    .filter(event => event.data?.walletId === wallet.id).map(event => event.data.walletVersion);
  expect(walletEventOrder).toEqual([...walletEventOrder].sort((a, b) => a - b));
}, 15_000);

test("continuous runtime commits, ACKs and publishes with real PostgreSQL and SQS", async () => {
  // Dedicated schema prevents the real background publisher claiming unrelated events.
  const schema = `test_sqs_${randomUUID().replaceAll("-", "")}`;
  const isolated = await MikroORM.init({ ...ormConfig, schema });
  let runtime: MessagingRuntime | undefined;
  try {
    await isolated.schema.create();
    const incoming = await queue();
    const outgoing = await queue();
    const wallet = await new CreateWalletUseCase(new MikroOrmUnitOfWork(isolated.em), new MikroOrmWalletRepository(),
      new MikroOrmWagerTransactionRepository(), new MikroOrmLedgerRepository(), new MikroOrmOutboxRepository(),
      { generate: randomUUID }).execute({ playerId: randomUUID(), initialBalance: Money.from({ amount: "100.00", currency: "BRL" }), now: new Date() });
    const useCase = new ProcessBetUseCase(new MikroOrmUnitOfWork(isolated.em), new MikroOrmWagerTransactionRepository(),
      new MikroOrmWalletRepository(), new MikroOrmLedgerRepository(), new MikroOrmOutboxRepository(),
      { generate: randomUUID }, new MikroOrmInboxRepository());
    let failures = 0;
    runtime = new MessagingRuntime(consumer(incoming, useCase),
      new PublishOutboxUseCase(new MikroOrmPublishableOutboxRepository(isolated.em), new SqsEventPublisher(client, outgoing)),
      () => { failures++; });
    runtime.start();
    const messageId = randomUUID();
    await send(incoming, JSON.stringify({ messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { providerId: runId, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(),
        playerId: wallet.playerId, walletId: wallet.id, roundId: "round", gameId: "game", kind: "BET",
        money: { amount: "25.00", currency: "BRL" } } }), wallet.id);
    await eventually(async () => {
      const em = isolated.em.fork();
      return await em.count(OutboxMessageOrmEntity, { publishedAt: { $ne: null } }) === 4 &&
        await em.count(InboxMessageOrmEntity, { consumerName, messageId }) === 1;
    });
    await runtime.beforeApplicationShutdown();
    const em = isolated.em.fork();
    const saved = await em.findOneOrFail(WalletOrmEntity, { id: wallet.id });
    expect(Money.from({ amount: saved.balance, currency: saved.currency }).toString()).toBe("75.00");
    expect(await em.count(LedgerEntryOrmEntity, { walletId: wallet.id })).toBe(2);
    expect(await em.count(OutboxMessageOrmEntity, { publishedAt: null })).toBe(0);
    expect(failures).toBe(0);
    expect((await client.send(new ReceiveMessageCommand({ QueueUrl: incoming, WaitTimeSeconds: 0 }))).Messages ?? []).toHaveLength(0);
    const receivedIds = new Set<string>();
    await eventually(async () => {
      const result = await client.send(new ReceiveMessageCommand({ QueueUrl: outgoing, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }));
      for (const message of result.Messages ?? []) receivedIds.add(JSON.parse(message.Body!).eventId);
      return receivedIds.size === 4;
    });
    const events = await em.find(OutboxMessageOrmEntity, {});
    expect(receivedIds).toEqual(new Set(events.map(event => event.id)));
  } finally {
    await runtime?.beforeApplicationShutdown();
    try {
      // Drops only tables in the generated schema, then that exact namespace.
      await isolated.schema.drop({ schema });
      await isolated.schema.dropNamespace(schema);
    } finally { await isolated.close(true); }
  }
}, 20_000);
