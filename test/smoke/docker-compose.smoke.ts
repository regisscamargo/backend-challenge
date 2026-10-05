import { randomUUID } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import ormConfig from "../../mikro-orm.config";
import { cleanupWithTriggersDisabled } from "../support/database-cleanup";
import { WalletOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wallet.orm-entity";
import { WagerTransactionOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wager-transaction.orm-entity";
import { LedgerEntryOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/ledger-entry.orm-entity";
import { InboxMessageOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/inbox-message.orm-entity";
import { OutboxMessageOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/outbox-message.orm-entity";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured in .env`);
  return value;
}
const baseUrl = requiredEnv("SMOKE_BASE_URL");
const queueUrl = requiredEnv("SMOKE_QUEUE_URL");
const playerId = randomUUID();
const providerId = `compose-smoke-${randomUUID()}`;
const externalTransactionId = randomUUID();
const messageId = randomUUID();
let walletId: string | undefined;
const sqs = new SQSClient({ region: requiredEnv("AWS_REGION"), endpoint: requiredEnv("AWS_ENDPOINT_URL") });
const orm = await MikroORM.init(ormConfig);

async function eventually<T>(read: () => Promise<T>, accepted: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  let value = await read();
  while (!accepted(value) && Date.now() < deadline) {
    await Bun.sleep(200);
    value = await read();
  }
  if (!accepted(value)) throw new Error("Docker Compose smoke test timed out");
  return value;
}

try {
  const readiness = await fetch(`${baseUrl}/health/ready`);
  if (!readiness.ok) throw new Error(`Readiness returned ${readiness.status}`);
  const created = await fetch(`${baseUrl}/wallets`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount: "100.00", currency: "BRL" } }),
  });
  if (created.status !== 201) throw new Error(`Wallet creation returned ${created.status}`);
  const wallet = await created.json() as { id: string; balance: { amount: string } };
  walletId = wallet.id;
  if (wallet.balance.amount !== "100.00") throw new Error("Unexpected opening balance");

  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageGroupId: walletId,
    MessageDeduplicationId: messageId,
    MessageBody: JSON.stringify({ messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
      data: { providerId, externalTransactionId, idempotencyKey: `${providerId}:${externalTransactionId}`,
        playerId, walletId, roundId: "smoke-round", gameId: "smoke-game", kind: "BET",
        money: { amount: "25.00", currency: "BRL" } } }),
  }));

  const finalWallet = await eventually(async () => {
    const response = await fetch(`${baseUrl}/wallets/${walletId}`);
    return response.json() as Promise<{ balance: { amount: string }; version: number }>;
  }, value => value.balance.amount === "75.00");
  if (finalWallet.version !== 2) throw new Error("Unexpected wallet version after SQS BET");

  const transaction = await fetch(`${baseUrl}/providers/${providerId}/wagering/transactions/${externalTransactionId}`);
  if (!transaction.ok || (await transaction.json() as { status: string }).status !== "PROCESSED") {
    throw new Error("Processed transaction was not queryable");
  }
  await eventually(async () => await (await fetch(`${baseUrl}/metrics`)).text(),
    metrics => metrics.includes("wager_outbox_pending 0"));
  console.log(JSON.stringify({ status: "ok", transport: "SQS", walletId, balance: "75.00", version: 2 }));
} finally {
  if (walletId) {
    const cleanupWalletId = walletId;
    await cleanupWithTriggersDisabled(orm.em, async em => {
      const transactions = await em.find(WagerTransactionOrmEntity, { walletId: cleanupWalletId });
      await em.nativeDelete(InboxMessageOrmEntity, { consumerName: "wager-processor", messageId });
      await em.nativeDelete(OutboxMessageOrmEntity, { aggregateId: { $in: [cleanupWalletId, ...transactions.map(tx => tx.id)] } });
      await em.nativeDelete(LedgerEntryOrmEntity, { walletId: cleanupWalletId });
      await em.nativeDelete(WagerTransactionOrmEntity, { walletId: cleanupWalletId });
      await em.nativeDelete(WalletOrmEntity, { id: cleanupWalletId });
    });
  }
  await orm.close(true);
  sqs.destroy();
}
