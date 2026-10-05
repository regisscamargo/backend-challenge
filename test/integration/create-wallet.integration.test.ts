import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import ormConfig from "../../mikro-orm.config";
import { CreateWalletUseCase } from "../../src/application/wallet/create-wallet.use-case";
import { Money } from "../../src/domain/money/money";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm/mikro-orm-unit-of-work";
import { MikroOrmWalletRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wallet.repository";
import { MikroOrmWagerTransactionRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmLedgerRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-ledger.repository";
import { MikroOrmOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-outbox.repository";
import { WalletOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wallet.orm-entity";
import { WagerTransactionOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wager-transaction.orm-entity";
import { LedgerEntryOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/ledger-entry.orm-entity";
import { OutboxMessageOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/outbox-message.orm-entity";
import type { OutboxRepository } from "../../src/application/outbox/ports";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "../../src/app.module";
import { ProcessBetUseCase } from "../../src/application/wagering/process-bet.use-case";
import { WalletReconciliationService } from "../../src/infrastructure/persistence/mikro-orm/wallet-reconciliation.service";
import { cleanupWithTriggersDisabled } from "../support/database-cleanup";

let orm: MikroORM;
const players: string[] = [];
beforeAll(async () => { orm = await MikroORM.init(ormConfig); });
afterAll(async () => {
  await cleanupWithTriggersDisabled(orm.em, async em => {
    const wallets = await em.find(WalletOrmEntity, { playerId: { $in: players } });
    const ids = wallets.map((wallet) => wallet.id);
    const transactions = await em.find(WagerTransactionOrmEntity, { walletId: { $in: ids } });
    await em.nativeDelete(OutboxMessageOrmEntity, { aggregateId: { $in: [...ids, ...transactions.map((tx) => tx.id)] } });
    await em.nativeDelete(LedgerEntryOrmEntity, { walletId: { $in: ids } });
    await em.nativeDelete(WagerTransactionOrmEntity, { walletId: { $in: ids } });
    await em.nativeDelete(WalletOrmEntity, { id: { $in: ids } });
  });
  await orm.close(true);
});
const make = (outbox: OutboxRepository = new MikroOrmOutboxRepository()) => new CreateWalletUseCase(
  new MikroOrmUnitOfWork(orm.em), new MikroOrmWalletRepository(), new MikroOrmWagerTransactionRepository(),
  new MikroOrmLedgerRepository(), outbox, { generate: randomUUID },
);
const input = (amount: string) => {
  const playerId = randomUUID();
  players.push(playerId);
  return { playerId, initialBalance: Money.from({ amount, currency: "BRL" }), now: new Date() };
};

test("creates wallet, internal OPENING, ledger and Outbox atomically with version one", async () => {
  const wallet = await make().execute(input("100.00"));
  const em = orm.em.fork();
  const saved = await em.findOneOrFail(WalletOrmEntity, { id: wallet.id });
  const transactions = await em.find(WagerTransactionOrmEntity, { walletId: wallet.id });
  const entries = await em.find(LedgerEntryOrmEntity, { walletId: wallet.id });
  expect(saved.version).toBe(1);
  expect(saved.balance).toBe("100.00");
  expect(transactions).toHaveLength(1);
  expect(transactions[0]?.kind).toBe("OPENING");
  expect(transactions[0]?.status).toBe("PROCESSED");
  expect(entries).toHaveLength(1);
  expect(entries[0]?.direction).toBe("CREDIT");
  expect(entries[0]?.balanceBefore).toBe("0.00");
  expect(entries[0]?.balanceAfter).toBe(saved.balance);
  expect(await em.count(OutboxMessageOrmEntity, { aggregateId: { $in: [wallet.id, ...transactions.map((tx) => tx.id)] } })).toBe(2);
});

test("zero balance creates no OPENING, ledger or balance event", async () => {
  const wallet = await make().execute(input("0.00"));
  const em = orm.em.fork();
  expect(wallet.version).toBe(1);
  expect(await em.count(WagerTransactionOrmEntity, { walletId: wallet.id })).toBe(0);
  expect(await em.count(LedgerEntryOrmEntity, { walletId: wallet.id })).toBe(0);
  expect(await em.count(OutboxMessageOrmEntity, { aggregateId: wallet.id })).toBe(0);
});

test("concurrent creation permits one wallet per player and currency", async () => {
  const request = input("25.00");
  const results = await Promise.allSettled([make().execute(request), make().execute(request)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  if (!rejected || rejected.status !== "rejected") throw new Error("Expected duplicate conflict");
  expect(rejected.reason.code).toBe("WALLET_ALREADY_EXISTS");
  expect(await orm.em.fork().count(WalletOrmEntity, { playerId: request.playerId })).toBe(1);
});

test("failure after database inserts rolls back wallet, OPENING, ledger and Outbox", async () => {
  const request = input("100.00");
  const delegate = new MikroOrmOutboxRepository();
  const failing: OutboxRepository = {
    insert: async (message, context) => {
      await delegate.insert(message, context);
      const em = context.transaction as MikroORM["em"];
      await em.flush();
      throw new Error("injected failure after financial inserts");
    },
  };
  const before = await orm.em.fork().count(OutboxMessageOrmEntity, {});
  await expect(make(failing).execute(request)).rejects.toThrow("injected failure");
  expect(await orm.em.fork().count(WalletOrmEntity, { playerId: request.playerId })).toBe(0);
  expect(await orm.em.fork().count(WagerTransactionOrmEntity, { playerId: request.playerId })).toBe(0);
  expect(await orm.em.fork().count(OutboxMessageOrmEntity, {})).toBe(before);
});

test("POST /wallets returns 201, duplicate 409 and invalid payload 400", async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  try {
    await app.listen(0, "127.0.0.1");
    const url = `${await app.getUrl()}/wallets`;
    const request = input("75.00");
    const body = JSON.stringify({ playerId: request.playerId, initialBalance: request.initialBalance.toJSON() });
    const submit = (payload: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    const created = await submit(body);
    expect(created.status).toBe(201);
    const result = await created.json() as { version: number; balance: { amount: string } };
    expect(result.version).toBe(1);
    expect(result.balance.amount).toBe("75.00");
    const duplicate = await submit(body);
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json() as { error: string }).error).toBe("WALLET_ALREADY_EXISTS");
    expect((await submit(JSON.stringify({ playerId: request.playerId }))).status).toBe(400);
    expect((await submit(JSON.stringify({ playerId: "invalid", initialBalance: { amount: "0.00", currency: "BRL" } }))).status).toBe(400);
  } finally {
    await app.close();
  }
});

test("POST /wagering/transactions distinguishes processed, pending, rejected and conflicting requests", async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const wallet = await make().execute(input("100.00"));
    const providerId = `http-contract-${wallet.id}`;
    const submit = (key: string | undefined, payload: Record<string, unknown>) => fetch(`${base}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(payload),
    });
    const body = (overrides: Record<string, unknown> = {}) => ({
      providerId, externalTransactionId: randomUUID(), playerId: wallet.playerId, walletId: wallet.id,
      roundId: "round", gameId: "game", kind: "BET",
      money: { amount: "25.00", currency: "BRL" }, ...overrides,
    });

    const invalid = await submit("invalid", { providerId });
    expect(invalid.status).toBe(400);
    const missingKey = await submit(undefined, body());
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json() as { error: string }).error).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const processedBody = body();
    const processed = await submit("processed", processedBody);
    expect(processed.status).toBe(201);
    expect((await processed.json() as { status: string }).status).toBe("PROCESSED");
    const replay = await submit("processed", processedBody);
    expect(replay.status).toBe(201);
    expect((await replay.json() as { idempotentReplay: boolean }).idempotentReplay).toBe(true);
    const conflict = await submit("processed", { ...processedBody, gameId: "different-game" });
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: string }).error).toBe("IDEMPOTENCY_CONFLICT");

    const externalIdConflict = await submit("different-key", processedBody);
    expect(externalIdConflict.status).toBe(409);
    expect((await externalIdConflict.json() as { error: string }).error).toBe("IDEMPOTENCY_CONFLICT");

    const wrongScale = await submit("wrong-scale", body({ money: { amount: "1.0", currency: "BRL" } }));
    expect(wrongScale.status).toBe(400);
    const negativeAmount = await submit("negative", body({ money: { amount: "-1.00", currency: "BRL" } }));
    expect(negativeAmount.status).toBe(400);

    const rejected = await submit("rejected", body({ money: { amount: "1000.00", currency: "BRL" } }));
    expect(rejected.status).toBe(422);
    const rejectedResult = await rejected.json() as { status: string; failureCode: string };
    expect(rejectedResult).toEqual(expect.objectContaining({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" }));

    const pending = await submit("pending", body({ kind: "REFUND", referenceExternalTransactionId: randomUUID() }));
    expect(pending.status).toBe(202);
    expect((await pending.json() as { status: string }).status).toBe("PENDING_REFERENCE");
  } finally { await app.close(); }
});

test("HTTP queries isolate providers and paginate ledger with tied timestamps", async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const request = input("100.00");
    const wallet = await make().execute(request);
    const useCase = app.get(ProcessBetUseCase);
    const transactionIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const tx = await useCase.execute({
        providerId: `query-${wallet.id}`, externalTransactionId: `bet-${index}`,
        idempotencyKey: `bet-${index}`, payloadHash: String(index).repeat(64),
        walletId: wallet.id, playerId: wallet.playerId, roundId: "round", gameId: "game",
        money: Money.from({ amount: "10.00", currency: "BRL" }), now: request.now,
      });
      transactionIds.push(tx.transactionId);
    }
    const walletResponse = await fetch(`${base}/wallets/${wallet.id}`);
    expect(walletResponse.status).toBe(200);
    expect((await walletResponse.json() as { balance: { amount: string } }).balance.amount).toBe("60.00");
    const reconciliation = await fetch(`${base}/wallets/${wallet.id}/reconciliation`, { method: "POST" });
    expect(reconciliation.status).toBe(200);
    const reconciliationResult = await reconciliation.json() as { consistent: boolean; checkedEntries: number; calculatedBalance: { amount: string } };
    expect(reconciliationResult.consistent).toBe(true);
    expect(reconciliationResult.checkedEntries).toBe(5);
    expect(reconciliationResult.calculatedBalance.amount).toBe("60.00");
    const metricsResponse = await fetch(`${base}/metrics`);
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers.get("content-type")).toContain("text/plain");
    const metrics = await metricsResponse.text();
    expect(metrics).toContain('wager_transactions_total{status="PROCESSED"} 4');
    expect(metrics).toContain("wager_processing_duration_seconds_count 4");
    expect(metrics).toContain('wager_metrics_dependency_up{dependency="postgres"} 1');
    expect(metrics).toContain('wager_metrics_dependency_up{dependency="sqs"} 1');
    const transactionResponse = await fetch(`${base}/wagering/transactions/${transactionIds[0]}`);
    expect(transactionResponse.status).toBe(200);
    const tx = await transactionResponse.json() as { transactionId: string; balance: { amount: string }; payloadHash?: string };
    expect(tx.balance.amount).toBe("90.00");
    expect(tx.payloadHash).toBeUndefined();
    const externalResponse = await fetch(`${base}/providers/query-${wallet.id}/wagering/transactions/bet-0`);
    expect(externalResponse.status).toBe(200);
    expect((await externalResponse.json() as { transactionId: string }).transactionId).toBe(tx.transactionId);
    expect((await fetch(`${base}/providers/other-provider/wagering/transactions/bet-0`)).status).toBe(404);

    const seen: string[] = [];
    let cursor: string | null = null;
    let firstCursor = "";
    const lengths: number[] = [];
    for (let page = 0; page < 4; page += 1) {
      const response = await fetch(`${base}/wallets/${wallet.id}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(response.status).toBe(200);
      const result = await response.json() as { items: { id: string; money: { amount: string } }[]; nextCursor: string | null };
      lengths.push(result.items.length);
      seen.push(...result.items.map((entry) => entry.id));
      for (const entry of result.items) expect(typeof entry.money.amount).toBe("string");
      cursor = result.nextCursor;
      if (page === 0) firstCursor = cursor ?? "";
      if (!cursor) break;
    }
    const expected = await orm.em.fork().find(LedgerEntryOrmEntity, { walletId: wallet.id },
      { orderBy: { createdAt: "ASC", id: "ASC" } });
    expect(lengths).toEqual([2, 2, 1]);
    expect(seen).toEqual(expected.map((entry) => entry.id));
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeNull();
    expect((await fetch(`${base}/wallets/${wallet.id}/ledger?cursor=invalid`)).status).toBe(400);
    for (const limit of ["0", "101", "1.5", "invalid"]) {
      expect((await fetch(`${base}/wallets/${wallet.id}/ledger?limit=${limit}`)).status).toBe(400);
    }
    const other = await make().execute(input("0.00"));
    expect((await fetch(`${base}/wallets/${other.id}/ledger?cursor=${firstCursor}`)).status).toBe(400);
    expect((await fetch(`${base}/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await fetch(`${base}/wagering/transactions/${randomUUID()}`)).status).toBe(404);
    expect((await fetch(`${base}/wallets/not-a-uuid`)).status).toBe(400);
    const empty = await fetch(`${base}/wallets/${other.id}/ledger`);
    expect(await empty.json()).toEqual({ items: [], nextCursor: null });
  } finally {
    await app.close();
  }
});

test("reconciliation detects drift without repairing wallet or ledger and increments its counter", async () => {
  const wallet = await make().execute(input("100.00"));
  // Deliberate corruption limited to this test's wallet to prove detection.
  await orm.em.fork().nativeUpdate(WalletOrmEntity, { id: wallet.id }, { balance: "99.00" });
  const service = new WalletReconciliationService(orm.em);
  const result = await service.execute(wallet.id, randomUUID());
  expect(result.consistent).toBe(false);
  expect(result.storedBalance.amount).toBe("99.00");
  expect(result.calculatedBalance.amount).toBe("100.00");
  expect(result.difference.amount).toBe("-1.00");
  expect(result.checkedEntries).toBe(1);
  expect(service.divergenceCount).toBe(1);
  const em = orm.em.fork();
  expect((await em.findOneOrFail(WalletOrmEntity, { id: wallet.id })).balance).toBe("99.00");
  expect(await em.count(LedgerEntryOrmEntity, { walletId: wallet.id })).toBe(1);
  const zero = await make().execute(input("0.00"));
  const empty = await service.execute(zero.id, randomUUID());
  expect(empty.consistent).toBe(true);
  expect(empty.checkedEntries).toBe(0);
  expect(empty.calculatedBalance.amount).toBe("0.00");
  expect(service.divergenceCount).toBe(1);
  await expect(service.execute(randomUUID(), randomUUID())).rejects.toThrow("WALLET_NOT_FOUND");
});

test("reconciliation stays consistent during concurrent wallet movements", async () => {
  const request = input("100.00");
  const wallet = await make().execute(request);
  const service = new WalletReconciliationService(orm.em);
  const process = new ProcessBetUseCase(new MikroOrmUnitOfWork(orm.em), new MikroOrmWagerTransactionRepository(),
    new MikroOrmWalletRepository(), new MikroOrmLedgerRepository(), new MikroOrmOutboxRepository(), { generate: randomUUID });
  await Promise.all(Array.from({ length: 5 }, async (_, index) => {
    await Promise.all([
      process.execute({ providerId: `reconcile-${wallet.id}`, externalTransactionId: `bet-${index}`, idempotencyKey: `bet-${index}`,
        payloadHash: String(index).repeat(64), walletId: wallet.id, playerId: wallet.playerId, roundId: "round", gameId: "game",
        money: Money.from({ amount: "10.00", currency: "BRL" }), now: new Date() }),
      service.execute(wallet.id, randomUUID()).then((result) => { expect(result.consistent).toBe(true); }),
    ]);
  }));
  const final = await service.execute(wallet.id, randomUUID());
  expect(final.consistent).toBe(true);
  expect(final.storedBalance.amount).toBe("50.00");
  expect(final.calculatedBalance.amount).toBe("50.00");
  expect(final.checkedEntries).toBe(6);
  expect(service.divergenceCount).toBe(0);
});
