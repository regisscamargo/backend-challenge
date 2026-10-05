import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { ApplyWalletMovementUseCase } from "../../src/application/wallet/apply-wallet-movement.use-case";
import { ProcessBetUseCase } from "../../src/application/wagering/process-bet.use-case";
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";
import { LedgerDirection } from "../../src/domain/wallet/wallet";
import { Money } from "../../src/domain/money/money";
import { LedgerEntryOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/ledger-entry.orm-entity";
import { OutboxMessageOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/outbox-message.orm-entity";
import { InboxMessageOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/inbox-message.orm-entity";
import { WagerTransactionOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wager-transaction.orm-entity";
import { WalletOrmEntity } from "../../src/infrastructure/persistence/mikro-orm/entities/wallet.orm-entity";
import { MikroOrmLedgerRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-ledger.repository";
import { MikroOrmWalletRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wallet.repository";
import { MikroOrmWagerTransactionRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-outbox.repository";
import { MikroOrmPublishableOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-publishable-outbox.repository";
import { MikroOrmInboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-inbox.repository";
import { PendingReferenceWorker } from "../../src/application/wagering/pending-reference.worker";
import { PublishOutboxUseCase } from "../../src/application/outbox/publish-outbox.use-case";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm/mikro-orm-unit-of-work";
import ormConfig from "../../mikro-orm.config";
import { cleanupWithTriggersDisabled } from "../support/database-cleanup";

const money = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("PostgreSQL persistence", () => {
  let orm: MikroORM;
  let walletId: string;
  let transactionId: string;
  const extraWalletIds: string[] = [];
  const extraTransactionIds: string[] = [];
  const extraOutboxIds: string[] = [];
  const extraInboxMessageIds: string[] = [];

  beforeAll(async () => {
    orm = await MikroORM.init(ormConfig);
    walletId = randomUUID();
    transactionId = randomUUID();

    const em = orm.em.fork();
    const now = new Date("2026-10-03T12:00:00.000Z");

    const wallet = em.create(WalletOrmEntity, {
        id: walletId,
        playerId: randomUUID(),
        currency: "BRL",
        balance: "100.00",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    em.persist(wallet);
    await em.flush();

    em.persist(
      em.create(WagerTransactionOrmEntity, {
        id: transactionId,
        providerId: `integration-${walletId}`,
        externalTransactionId: `external-${transactionId}`,
        idempotencyKey: `key-${transactionId}`,
        payloadHash: "a".repeat(64),
        walletId,
        playerId: randomUUID(),
        roundId: "round-1",
        gameId: "game-1",
        kind: "BET",
        amount: "25.00",
        currency: "BRL",
        status: "PENDING",
        createdAt: now,
      }),
    );
    await em.flush();
  });

  afterAll(async () => {
    await cleanupWithTriggersDisabled(orm.em, async em => {
      await em.nativeDelete(LedgerEntryOrmEntity, { walletId });
      await em.nativeDelete(WagerTransactionOrmEntity, { id: transactionId });
      await em.nativeDelete(WalletOrmEntity, { id: walletId });
      await em.nativeDelete(LedgerEntryOrmEntity, { walletId: { $in: extraWalletIds } });
      await em.nativeDelete(OutboxMessageOrmEntity, { aggregateId: { $in: extraWalletIds } });
      await em.nativeDelete(WagerTransactionOrmEntity, { id: { $in: extraTransactionIds } });
      await em.nativeDelete(OutboxMessageOrmEntity, { aggregateId: { $in: extraTransactionIds } });
      await em.nativeDelete(OutboxMessageOrmEntity, { id: { $in: extraOutboxIds } });
      await em.nativeDelete(InboxMessageOrmEntity, { messageId: { $in: extraInboxMessageIds } });
      await em.nativeDelete(WalletOrmEntity, { id: { $in: extraWalletIds } });
    });
    await orm.close(true);
  });

  test("persists wallet movement and ledger in PostgreSQL", async () => {
    const useCase = new ApplyWalletMovementUseCase(
      new MikroOrmUnitOfWork(orm.em),
      new MikroOrmWalletRepository(),
      new MikroOrmLedgerRepository(),
      { generate: () => randomUUID() },
    );

    const output = await useCase.execute({
      walletId,
      transactionId,
      direction: LedgerDirection.Debit,
      money: money("25.00"),
      now: new Date("2026-10-03T12:01:00.000Z"),
    });

    expect(output.wallet.balance.toString()).toBe("75.00");

    const em = orm.em.fork();
    const persistedWallet = await em.findOneOrFail(WalletOrmEntity, { id: walletId });
    const entries = await em.find(LedgerEntryOrmEntity, { walletId });

    expect(persistedWallet.balance).toBe("75.00");
    expect(persistedWallet.version).toBe(2);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.balanceBefore).toBe("100.00");
    expect(entries[0]?.balanceAfter).toBe("75.00");
  });

  test("database trigger makes ledger entries append-only", async () => {
    const em = orm.em.fork();
    const entry = await em.findOneOrFail(LedgerEntryOrmEntity, { walletId });
    const connection = em.getConnection();

    await expect(connection.execute(
      "UPDATE wallet_ledger_entries SET amount = ? WHERE id = ?",
      ["1.00", entry.id],
    )).rejects.toMatchObject({ code: "P0001" });
    await expect(connection.execute(
      "DELETE FROM wallet_ledger_entries WHERE id = ?",
      [entry.id],
    )).rejects.toMatchObject({ code: "P0001" });

    const unchanged = await orm.em.fork().findOneOrFail(LedgerEntryOrmEntity, { id: entry.id });
    expect(unchanged.amount).toBe("25.00");
    expect(unchanged.balanceBefore).toBe("100.00");
    expect(unchanged.balanceAfter).toBe("75.00");
    expect(await orm.em.fork().count(LedgerEntryOrmEntity, { id: entry.id })).toBe(1);

    const trigger = await connection.execute<{ enabled: string }[]>(`
      SELECT tgenabled AS enabled
      FROM pg_trigger
      WHERE tgname = 'wallet_ledger_entries_append_only'
        AND tgrelid = 'wallet_ledger_entries'::regclass
        AND NOT tgisinternal
    `);
    expect(trigger).toEqual([{ enabled: "O" }]);
  });

  test("serializes concurrent debits on the same wallet", async () => {
    const concurrentWalletId = randomUUID();
    const firstTransactionId = randomUUID();
    const secondTransactionId = randomUUID();
    extraWalletIds.push(concurrentWalletId);
    extraTransactionIds.push(firstTransactionId, secondTransactionId);

    const em = orm.em.fork();
    const now = new Date("2026-10-03T13:00:00.000Z");
    em.persist(
      em.create(WalletOrmEntity, {
        id: concurrentWalletId,
        playerId: randomUUID(),
        currency: "BRL",
        balance: "100.00",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await em.flush();

    for (const [index, id] of [firstTransactionId, secondTransactionId].entries()) {
      em.persist(
        em.create(WagerTransactionOrmEntity, {
          id,
          providerId: `concurrent-${concurrentWalletId}`,
          externalTransactionId: `external-${id}`,
          idempotencyKey: `key-${id}`,
          payloadHash: `${index}`.repeat(64),
          walletId: concurrentWalletId,
          playerId: randomUUID(),
          roundId: "round-concurrent",
          gameId: "game-concurrent",
          kind: "BET",
          amount: "80.00",
          currency: "BRL",
          status: "PENDING",
          createdAt: now,
        }),
      );
    }
    await em.flush();

    const createUseCase = () =>
      new ApplyWalletMovementUseCase(
        new MikroOrmUnitOfWork(orm.em),
        new MikroOrmWalletRepository(),
        new MikroOrmLedgerRepository(),
        { generate: () => randomUUID() },
      );

    const outcomes = await Promise.allSettled([
      createUseCase().execute({
        walletId: concurrentWalletId,
        transactionId: firstTransactionId,
        direction: LedgerDirection.Debit,
        money: money("80.00"),
        now,
      }),
      createUseCase().execute({
        walletId: concurrentWalletId,
        transactionId: secondTransactionId,
        direction: LedgerDirection.Debit,
        money: money("80.00"),
        now,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

    const verificationEm = orm.em.fork();
    const persistedWallet = await verificationEm.findOneOrFail(WalletOrmEntity, {
      id: concurrentWalletId,
    });
    const entries = await verificationEm.find(LedgerEntryOrmEntity, {
      walletId: concurrentWalletId,
    });

    expect(persistedWallet.balance).toBe("20.00");
    expect(persistedWallet.version).toBe(2);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount).toBe("80.00");
  });

  test("replays the original result and rejects a different payload hash", async () => {
    const idempotentWalletId = randomUUID();
    const idempotentPlayerId = randomUUID();
    extraWalletIds.push(idempotentWalletId);

    const em = orm.em.fork();
    const now = new Date("2026-10-03T14:00:00.000Z");
    em.persist(
      em.create(WalletOrmEntity, {
        id: idempotentWalletId,
        playerId: idempotentPlayerId,
        currency: "BRL",
        balance: "100.00",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await em.flush();

    const useCase = new ProcessBetUseCase(
      new MikroOrmUnitOfWork(orm.em),
      new MikroOrmWagerTransactionRepository(),
      new MikroOrmWalletRepository(),
      new MikroOrmLedgerRepository(),
      new MikroOrmOutboxRepository(),
      { generate: () => randomUUID() },
    );
    const input = {
      providerId: "provider-idempotency",
      externalTransactionId: `external-${idempotentWalletId}`,
      idempotencyKey: `key-${idempotentWalletId}`,
      payloadHash: "b".repeat(64),
      walletId: idempotentWalletId,
      playerId: idempotentPlayerId,
      roundId: "round-idempotency",
      gameId: "game-idempotency",
      money: money("25.00"),
      now,
    };

    const first = await useCase.execute(input);
    extraTransactionIds.push(first.transactionId);
    const replay = await useCase.execute(input);
    const conflict = useCase.execute({ ...input, payloadHash: "c".repeat(64) });

    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(first.idempotentReplay).toBe(false);
    expect(first.balance?.toString()).toBe("75.00");
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance?.toString()).toBe("75.00");
    expect(conflict).rejects.toThrow("IDEMPOTENCY_CONFLICT");

    const verificationEm = orm.em.fork();
    const entries = await verificationEm.find(LedgerEntryOrmEntity, {
      walletId: idempotentWalletId,
    });
    expect(entries).toHaveLength(1);

    const outbox = await verificationEm.find(OutboxMessageOrmEntity, {
      $or: [
        { aggregateId: idempotentWalletId },
        { aggregateId: first.transactionId },
      ],
    });
    expect(outbox).toHaveLength(2);
    expect(outbox.map((message) => message.eventType).sort()).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);

    const published: string[] = [];
    const publisher = new PublishOutboxUseCase(
      new MikroOrmPublishableOutboxRepository(orm.em),
      {
        publish: async (message) => {
          published.push(message.eventType);
        },
      },
    );
    const publishedResult = await publisher.execute(new Date("2026-10-03T14:01:00.000Z"));
    const secondRun = await publisher.execute(new Date("2026-10-03T14:02:00.000Z"));

    // An interrupted run can leave other due events in this shared database.
    // Assert batch accounting plus the two scoped events rather than global emptiness.
    expect(publishedResult.claimed).toBeGreaterThanOrEqual(2);
    expect(publishedResult.published).toBe(publishedResult.claimed);
    expect(publishedResult.scheduledForRetry).toBe(0);
    expect(published).toHaveLength(publishedResult.claimed);
    expect(secondRun.claimed).toBe(0);

    const publishedOutbox = await verificationEm.find(OutboxMessageOrmEntity, {
      $or: [
        { aggregateId: idempotentWalletId },
        { aggregateId: first.transactionId },
      ],
    });
    expect(publishedOutbox.every((message) => message.publishedAt !== null)).toBe(true);
  });

  test("reclaims an outbox message whose publisher lease expired", async () => {
    const staleOutboxId = randomUUID();
    extraOutboxIds.push(staleOutboxId);
    const em = orm.em.fork();
    em.persist(
      em.create(
        OutboxMessageOrmEntity,
        {
          id: staleOutboxId,
          aggregateId: randomUUID(),
          eventType: "LeaseRecoveryTest",
          payload: { eventId: staleOutboxId },
          occurredAt: new Date("2026-10-03T14:50:00.000Z"),
          attempts: 0,
          nextAttemptAt: null,
          publishedAt: null,
          lockedAt: new Date("2026-10-03T14:50:00.000Z"),
          lockedBy: "dead-worker",
          lastError: null,
        },
        { partial: true },
      ),
    );
    await em.flush();

    const published: string[] = [];
    const publisher = new PublishOutboxUseCase(
      new MikroOrmPublishableOutboxRepository(orm.em, 60_000),
      {
        publish: async (message) => {
          published.push(message.eventType);
        },
      },
    );

    const result = await publisher.execute(new Date("2026-10-03T14:52:00.000Z"), 1);

    expect(result).toEqual({ claimed: 1, published: 1, scheduledForRetry: 0 });
    expect(published).toEqual(["LeaseRecoveryTest"]);
  });

  test("persists Inbox and treats SQS redelivery as a replay", async () => {
    const inboxWalletId = randomUUID();
    const inboxPlayerId = randomUUID();
    const messageId = randomUUID();
    extraWalletIds.push(inboxWalletId);
    extraInboxMessageIds.push(messageId);

    const em = orm.em.fork();
    const now = new Date("2026-10-03T16:00:00.000Z");
    em.persist(
      em.create(
        WalletOrmEntity,
        {
          id: inboxWalletId,
          playerId: inboxPlayerId,
          currency: "BRL",
          balance: "100.00",
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        { partial: true },
      ),
    );
    await em.flush();

    const useCase = new ProcessBetUseCase(
      new MikroOrmUnitOfWork(orm.em),
      new MikroOrmWagerTransactionRepository(),
      new MikroOrmWalletRepository(),
      new MikroOrmLedgerRepository(),
      new MikroOrmOutboxRepository(),
      { generate: () => randomUUID() },
      new MikroOrmInboxRepository(),
    );
    const input = {
      providerId: "provider-inbox",
      externalTransactionId: `external-${inboxWalletId}`,
      idempotencyKey: `key-${inboxWalletId}`,
      payloadHash: "d".repeat(64),
      walletId: inboxWalletId,
      playerId: inboxPlayerId,
      roundId: "round-inbox",
      gameId: "game-inbox",
      money: money("30.00"),
      now,
      inbox: {
        messageId,
        consumerName: "wager-transaction-consumer",
        receivedAt: now,
      },
    };

    const first = await useCase.execute(input);
    extraTransactionIds.push(first.transactionId);
    const redelivery = await useCase.execute(input);

    expect(first.idempotentReplay).toBe(false);
    expect(redelivery.idempotentReplay).toBe(true);
    expect(redelivery.transactionId).toBe(first.transactionId);

    const inbox = await orm.em.fork().findOneOrFail(InboxMessageOrmEntity, {
      consumerName: "wager-transaction-consumer",
      messageId,
    });
    expect(inbox.processedAt).not.toBeNull();
  });

  test("persists invalid reference rejections with Inbox and Outbox but no financial effect", async () => {
    const id = randomUUID();
    const playerId = randomUUID();
    const now = new Date();
    extraWalletIds.push(id);
    const em = orm.em.fork();
    em.persist(em.create(WalletOrmEntity, {
      id, playerId, currency: "BRL", balance: "100.00", version: 1, createdAt: now, updatedAt: now,
    }));
    await em.flush();
    const useCase = new ProcessBetUseCase(
      new MikroOrmUnitOfWork(orm.em), new MikroOrmWagerTransactionRepository(),
      new MikroOrmWalletRepository(), new MikroOrmLedgerRepository(),
      new MikroOrmOutboxRepository(), { generate: () => randomUUID() }, new MikroOrmInboxRepository(),
    );
    const cases = [
      { label: "wrong round", referenceKind: "BET", kind: WagerTransactionKind.Refund, roundId: "other", currency: "BRL", amount: "25.00", status: "PROCESSED", expected: FailureCode.InvalidReference },
      { label: "wrong player", referenceKind: "BET", kind: WagerTransactionKind.Refund, referencePlayerId: randomUUID(), currency: "BRL", amount: "25.00", status: "PROCESSED", expected: FailureCode.InvalidReference },
      { label: "wrong currency", referenceKind: "BET", kind: WagerTransactionKind.Win, currency: "USD", amount: "25.00", status: "PROCESSED", expected: FailureCode.CurrencyMismatch },
      { label: "partial reversal", referenceKind: "BET", kind: WagerTransactionKind.Rollback, currency: "BRL", amount: "20.00", status: "PROCESSED", expected: FailureCode.InvalidReference },
      { label: "refund of win", referenceKind: "WIN", kind: WagerTransactionKind.Refund, currency: "BRL", amount: "25.00", status: "PROCESSED", expected: FailureCode.InvalidReference },
      { label: "win of win", referenceKind: "WIN", kind: WagerTransactionKind.Win, currency: "BRL", amount: "25.00", status: "PROCESSED", expected: FailureCode.InvalidReference },
      { label: "rollback of loss", referenceKind: "LOSS", kind: WagerTransactionKind.Rollback, currency: "BRL", amount: "25.00", status: "PROCESSED", expected: FailureCode.InvalidReference },
      { label: "rejected reference", referenceKind: "BET", kind: WagerTransactionKind.Refund, currency: "BRL", amount: "25.00", status: "REJECTED", expected: FailureCode.InvalidReference },
    ];
    for (const [index, scenario] of cases.entries()) {
      const referenceId = randomUUID();
      const externalId = `reference-${referenceId}`;
      extraTransactionIds.push(referenceId);
      em.persist(em.create(WagerTransactionOrmEntity, {
        id: referenceId, providerId: `invalid-${id}`, externalTransactionId: externalId,
        idempotencyKey: externalId, payloadHash: "a".repeat(64), walletId: id,
        playerId: scenario.referencePlayerId ?? playerId, roundId: "round", gameId: "game",
        kind: scenario.referenceKind, amount: "25.00", currency: "BRL", status: scenario.status, createdAt: now,
      }));
      await em.flush();
      const messageId = randomUUID();
      extraInboxMessageIds.push(messageId);
      const input = {
        providerId: `invalid-${id}`, externalTransactionId: `request-${messageId}`,
        idempotencyKey: `request-${messageId}`, payloadHash: String(index).repeat(64),
        walletId: id, playerId, roundId: scenario.roundId ?? "round", gameId: "game",
        kind: scenario.kind, referenceExternalTransactionId: externalId,
        money: Money.from({ amount: scenario.amount, currency: scenario.currency }), now,
        inbox: { messageId, consumerName: "invalid-reference-test", receivedAt: now },
      };
      const result = await useCase.execute(input);
      extraTransactionIds.push(result.transactionId);
      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(scenario.expected);
      const replay = await useCase.execute(input);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transactionId).toBe(result.transactionId);
      expect(replay.balance?.toString()).toBe("100.00");
      const verification = orm.em.fork();
      const saved = await verification.findOneOrFail(WagerTransactionOrmEntity, { id: result.transactionId });
      expect(saved.failureCode).toBe(scenario.expected);
      const events = await verification.find(OutboxMessageOrmEntity, { aggregateId: result.transactionId });
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe("WagerTransactionRejected");
      const inbox = await verification.findOneOrFail(InboxMessageOrmEntity, { consumerName: "invalid-reference-test", messageId });
      expect(inbox.processedAt).not.toBeNull();
    }
    const verification = orm.em.fork();
    const wallet = await verification.findOneOrFail(WalletOrmEntity, { id });
    expect(wallet.balance).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(await verification.count(LedgerEntryOrmEntity, { walletId: id })).toBe(0);
    expect(await verification.count(OutboxMessageOrmEntity, { aggregateId: id })).toBe(0);
  });

  for (const reversalKind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
    test(`serializes concurrent ${reversalKind} requests for the same reference`, async () => {
      const id = randomUUID();
      const playerId = randomUUID();
      const now = new Date();
      extraWalletIds.push(id);
      const em = orm.em.fork();
      em.persist(em.create(WalletOrmEntity, {
        id, playerId, currency: "BRL", balance: "0.00", version: 1, createdAt: now, updatedAt: now,
      }));
      await em.flush();
      const useCase = new ProcessBetUseCase(
        new MikroOrmUnitOfWork(orm.em), new MikroOrmWagerTransactionRepository(),
        new MikroOrmWalletRepository(), new MikroOrmLedgerRepository(),
        new MikroOrmOutboxRepository(), { generate: () => randomUUID() }, new MikroOrmInboxRepository(),
      );
      const base = { providerId: `race-${id}`, walletId: id, playerId, roundId: "round", gameId: "game", now };
      const win = await useCase.execute({
        ...base, externalTransactionId: `win-${id}`, idempotencyKey: `win-${id}`,
        payloadHash: "a".repeat(64), kind: WagerTransactionKind.Win, money: money("40.00"),
      });
      extraTransactionIds.push(win.transactionId);
      let referenceExternalTransactionId = `win-${id}`;
      if (reversalKind === WagerTransactionKind.Refund) {
        referenceExternalTransactionId = `bet-${id}`;
        const bet = await useCase.execute({
          ...base, externalTransactionId: referenceExternalTransactionId,
          idempotencyKey: referenceExternalTransactionId, payloadHash: "b".repeat(64),
          kind: WagerTransactionKind.Bet, money: money("40.00"),
        });
        extraTransactionIds.push(bet.transactionId);
      }
      const inputs = [0, 1].map((index) => {
        const messageId = randomUUID();
        extraInboxMessageIds.push(messageId);
        return {
          ...base, externalTransactionId: `reverse-${messageId}`, idempotencyKey: `reverse-${messageId}`,
          payloadHash: String(index).repeat(64), kind: reversalKind, referenceExternalTransactionId,
          money: money("40.00"), inbox: { messageId, consumerName: "reversal-race", receivedAt: now },
        };
      });
      const outcomes = await Promise.all(inputs.map((input) => useCase.execute(input)));
      extraTransactionIds.push(...outcomes.map((result) => result.transactionId));
      expect(outcomes.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
      expect(outcomes.filter((result) => result.failureCode === FailureCode.ReferenceAlreadyReversed)).toHaveLength(1);
      for (const [index, input] of inputs.entries()) {
        const original = outcomes[index];
        if (!original) throw new Error("Missing concurrent reversal result");
        const replay = await useCase.execute(input);
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.transactionId).toBe(original.transactionId);
        expect(replay.status).toBe(original.status);
      }
      const verification = orm.em.fork();
      const wallet = await verification.findOneOrFail(WalletOrmEntity, { id });
      const entries = await verification.find(LedgerEntryOrmEntity, { walletId: id });
      expect(entries).toHaveLength(reversalKind === WagerTransactionKind.Refund ? 3 : 2);
      const reconstructed = entries.reduce((balance, entry) => {
        const value = money(entry.amount);
        return entry.direction === "CREDIT" ? balance.add(value) : balance.subtract(value);
      }, money("0.00"));
      expect(wallet.balance).toBe(reconstructed.toString());
      expect(wallet.balance).toBe(reversalKind === WagerTransactionKind.Refund ? "40.00" : "0.00");
      expect(wallet.version).toBe(entries.length + 1);
      const reversalIds = outcomes.map((result) => result.transactionId);
      expect(await verification.count(LedgerEntryOrmEntity, { transactionId: { $in: reversalIds } })).toBe(1);
      expect(await verification.count(OutboxMessageOrmEntity, {
        aggregateId: { $in: reversalIds }, eventType: "WagerTransactionProcessed",
      })).toBe(1);
      expect(await verification.count(OutboxMessageOrmEntity, {
        aggregateId: { $in: reversalIds }, eventType: "WagerTransactionRejected",
      })).toBe(1);
    });
  }

  test("rejects rollback without funds and permits a new reversal after replenishment", async () => {
    const id = randomUUID();
    const playerId = randomUUID();
    const now = new Date();
    extraWalletIds.push(id);
    const em = orm.em.fork();
    em.persist(em.create(WalletOrmEntity, {
      id, playerId, currency: "BRL", balance: "0.00", version: 1, createdAt: now, updatedAt: now,
    }));
    await em.flush();
    const useCase = new ProcessBetUseCase(
      new MikroOrmUnitOfWork(orm.em), new MikroOrmWagerTransactionRepository(),
      new MikroOrmWalletRepository(), new MikroOrmLedgerRepository(),
      new MikroOrmOutboxRepository(), { generate: () => randomUUID() }, new MikroOrmInboxRepository(),
    );
    const base = { providerId: `negative-${id}`, walletId: id, playerId, roundId: "round", gameId: "game", now };
    for (const [external, kind, amount] of [
      ["win", WagerTransactionKind.Win, "50.00"], ["bet", WagerTransactionKind.Bet, "40.00"],
    ] as const) {
      const result = await useCase.execute({
        ...base, externalTransactionId: `${external}-${id}`, idempotencyKey: `${external}-${id}`,
        payloadHash: "c".repeat(64), kind, money: money(amount),
      });
      extraTransactionIds.push(result.transactionId);
    }
    const messageId = randomUUID();
    extraInboxMessageIds.push(messageId);
    const input = {
      ...base, externalTransactionId: `rollback-${id}`, idempotencyKey: `rollback-${id}`,
      payloadHash: "d".repeat(64), kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: `win-${id}`, money: money("50.00"),
      inbox: { messageId, consumerName: "negative-rollback", receivedAt: now },
    };
    const rejected = await useCase.execute(input);
    extraTransactionIds.push(rejected.transactionId);
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.ReversalWouldCreateNegativeBalance);
    expect(rejected.balance?.toString()).toBe("10.00");
    let verification = orm.em.fork();
    expect(await verification.count(LedgerEntryOrmEntity, { transactionId: rejected.transactionId })).toBe(0);
    expect((await verification.findOneOrFail(WalletOrmEntity, { id })).version).toBe(3);
    expect((await verification.findOneOrFail(InboxMessageOrmEntity, { messageId, consumerName: "negative-rollback" })).processedAt).not.toBeNull();
    const events = await verification.find(OutboxMessageOrmEntity, { aggregateId: rejected.transactionId });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("WagerTransactionRejected");
    const topup = await useCase.execute({
      ...base, externalTransactionId: `topup-${id}`, idempotencyKey: `topup-${id}`,
      payloadHash: "e".repeat(64), kind: WagerTransactionKind.Win, money: money("40.00"),
    });
    extraTransactionIds.push(topup.transactionId);
    const replay = await useCase.execute(input);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.failureCode).toBe(FailureCode.ReversalWouldCreateNegativeBalance);
    expect(replay.balance?.toString()).toBe("10.00");
    const newReversal = await useCase.execute({
      ...base, externalTransactionId: `retry-new-${id}`, idempotencyKey: `retry-new-${id}`,
      payloadHash: "f".repeat(64), kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: `win-${id}`, money: money("50.00"),
    });
    extraTransactionIds.push(newReversal.transactionId);
    expect(newReversal.status).toBe(WagerTransactionStatus.Processed);
    verification = orm.em.fork();
    const wallet = await verification.findOneOrFail(WalletOrmEntity, { id });
    const entries = await verification.find(LedgerEntryOrmEntity, { walletId: id });
    const reconstructed = entries.reduce((balance, entry) => entry.direction === "CREDIT"
      ? balance.add(money(entry.amount)) : balance.subtract(money(entry.amount)), money("0.00"));
    expect(entries).toHaveLength(4);
    expect(wallet.balance).toBe("0.00");
    expect(wallet.balance).toBe(reconstructed.toString());
    expect(wallet.version).toBe(5);
  });

  test("processes WIN and reversals with reference invariants", async () => {
    const lifecycleWalletId = randomUUID();
    const lifecyclePlayerId = randomUUID();
    extraWalletIds.push(lifecycleWalletId);
    const now = new Date("2026-10-03T17:00:00.000Z");
    const em = orm.em.fork();
    em.persist(em.create(WalletOrmEntity, {
      id: lifecycleWalletId,
      playerId: lifecyclePlayerId,
      currency: "BRL",
      balance: "100.00",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));
    await em.flush();

    const useCase = new ProcessBetUseCase(
      new MikroOrmUnitOfWork(orm.em),
      new MikroOrmWagerTransactionRepository(),
      new MikroOrmWalletRepository(),
      new MikroOrmLedgerRepository(),
      new MikroOrmOutboxRepository(),
      { generate: () => randomUUID() },
    );
    const base = {
      providerId: "provider-lifecycle",
      walletId: lifecycleWalletId,
      playerId: lifecyclePlayerId,
      roundId: "round-lifecycle",
      gameId: "game-lifecycle",
      now,
    };
    const bet = await useCase.execute({
      ...base,
      externalTransactionId: `bet-${lifecycleWalletId}`,
      idempotencyKey: `key-bet-${lifecycleWalletId}`,
      payloadHash: "1".repeat(64),
      money: money("30.00"),
    });
    const win = await useCase.execute({
      ...base,
      externalTransactionId: `win-${lifecycleWalletId}`,
      idempotencyKey: `key-win-${lifecycleWalletId}`,
      payloadHash: "2".repeat(64),
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: `bet-${lifecycleWalletId}`,
      money: money("20.00"),
    });
    const refund = await useCase.execute({
      ...base,
      externalTransactionId: `refund-${lifecycleWalletId}`,
      idempotencyKey: `key-refund-${lifecycleWalletId}`,
      payloadHash: "3".repeat(64),
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: `bet-${lifecycleWalletId}`,
      money: money("30.00"),
    });
    const duplicateRefund = await useCase.execute({
      ...base,
      externalTransactionId: `refund-duplicate-${lifecycleWalletId}`,
      idempotencyKey: `key-refund-duplicate-${lifecycleWalletId}`,
      payloadHash: "4".repeat(64),
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: `bet-${lifecycleWalletId}`,
      money: money("30.00"),
    });
    const rollback = await useCase.execute({
      ...base,
      externalTransactionId: `rollback-${lifecycleWalletId}`,
      idempotencyKey: `key-rollback-${lifecycleWalletId}`,
      payloadHash: "5".repeat(64),
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: `win-${lifecycleWalletId}`,
      money: money("20.00"),
    });
    extraTransactionIds.push(bet.transactionId, win.transactionId, refund.transactionId, duplicateRefund.transactionId, rollback.transactionId);

    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(duplicateRefund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);

    const verificationEm = orm.em.fork();
    const wallet = await verificationEm.findOneOrFail(WalletOrmEntity, { id: lifecycleWalletId });
    const entries = await verificationEm.find(LedgerEntryOrmEntity, { walletId: lifecycleWalletId });
    expect(wallet.balance).toBe("100.00");
    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.direction)).toEqual(["DEBIT", "CREDIT", "CREDIT", "DEBIT"]);
  });

  test("stores an out-of-order refund as PENDING_REFERENCE and retries it", async () => {
    const pendingWalletId = randomUUID();
    const pendingPlayerId = randomUUID();
    extraWalletIds.push(pendingWalletId);
    const now = new Date("2026-10-03T18:00:00.000Z");
    const em = orm.em.fork();
    em.persist(em.create(WalletOrmEntity, {
      id: pendingWalletId,
      playerId: pendingPlayerId,
      currency: "BRL",
      balance: "100.00",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));
    await em.flush();

    const transactions = new MikroOrmWagerTransactionRepository();
    const useCase = new ProcessBetUseCase(
      new MikroOrmUnitOfWork(orm.em), transactions,
      new MikroOrmWalletRepository(), new MikroOrmLedgerRepository(),
      new MikroOrmOutboxRepository(), { generate: () => randomUUID() },
    );
    const refund = await useCase.execute({
      providerId: "provider-pending",
      externalTransactionId: `refund-${pendingWalletId}`,
      idempotencyKey: `key-refund-${pendingWalletId}`,
      payloadHash: "6".repeat(64),
      walletId: pendingWalletId,
      playerId: pendingPlayerId,
      roundId: "round-pending",
      gameId: "game-pending",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: `bet-${pendingWalletId}`,
      money: money("30.00"),
      now,
    });
    extraTransactionIds.push(refund.transactionId);
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    const replay = await useCase.execute({
      providerId: "provider-pending",
      externalTransactionId: `refund-${pendingWalletId}`,
      idempotencyKey: `key-refund-${pendingWalletId}`,
      payloadHash: "6".repeat(64),
      walletId: pendingWalletId,
      playerId: pendingPlayerId,
      roundId: "round-pending",
      gameId: "game-pending",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: `bet-${pendingWalletId}`,
      money: money("30.00"),
      now: new Date(now.getTime() + 60_000),
    });
    expect(replay.idempotentReplay).toBe(true);
    const pendingRecord = await orm.em.fork().findOneOrFail(WagerTransactionOrmEntity, { id: refund.transactionId });
    expect(pendingRecord.referenceAttempts).toBe(1);

    const bet = await useCase.execute({
      providerId: "provider-pending",
      externalTransactionId: `bet-${pendingWalletId}`,
      idempotencyKey: `key-bet-${pendingWalletId}`,
      payloadHash: "7".repeat(64),
      walletId: pendingWalletId,
      playerId: pendingPlayerId,
      roundId: "round-pending",
      gameId: "game-pending",
      money: money("30.00"),
      now,
    });
    extraTransactionIds.push(bet.transactionId);

    await Promise.all(Array.from({ length: 3 }, () => new PendingReferenceWorker(
      new MikroOrmUnitOfWork(orm.em), transactions, useCase,
    ).run()));

    const verificationEm = orm.em.fork();
    const wallet = await verificationEm.findOneOrFail(WalletOrmEntity, { id: pendingWalletId });
    const persistedRefund = await verificationEm.findOneOrFail(WagerTransactionOrmEntity, { id: refund.transactionId });
    expect(persistedRefund.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance).toBe("100.00");
    const entries = await verificationEm.find(LedgerEntryOrmEntity, { walletId: pendingWalletId });
    expect(entries).toHaveLength(2);
    const refundEvents = await verificationEm.find(OutboxMessageOrmEntity, {
      aggregateId: refund.transactionId,
      eventType: "WagerTransactionProcessed",
    });
    expect(refundEvents).toHaveLength(1);
  });
});
