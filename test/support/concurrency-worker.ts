import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQSClient } from "@aws-sdk/client-sqs";
import ormConfig from "../../mikro-orm.config";
import { createTestSqsClient } from "./test-sqs-client";
import { ProcessBetInput, ProcessBetUseCase } from "../../src/application/wagering/process-bet.use-case";
import { PublishOutboxUseCase } from "../../src/application/outbox/publish-outbox.use-case";
import { UnitOfWork } from "../../src/application/shared/unit-of-work";
import { Money, MoneyProps } from "../../src/domain/money/money";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm/mikro-orm-unit-of-work";
import { MikroOrmWalletRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wallet.repository";
import { MikroOrmWagerTransactionRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmLedgerRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-ledger.repository";
import { MikroOrmOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-outbox.repository";
import { MikroOrmInboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-inbox.repository";
import { MikroOrmPublishableOutboxRepository } from "../../src/infrastructure/persistence/mikro-orm/repositories/mikro-orm-publishable-outbox.repository";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs/sqs-event.publisher";

export type WireInput = Omit<ProcessBetInput, "money" | "now" | "inbox"> & {
  money: MoneyProps;
  inbox: { messageId: string; consumerName: string };
};
export type WorkerJob = { type: "init" } & (
  { mode: "financial"; inputs: WireInput[] } |
  { mode: "publisher"; schema: string; queueUrl: string }
);

// Commands are buffered so fast parent messages cannot race listener registration.
const commands = new Map<string, unknown>();
const waiting = new Map<string, (value: unknown) => void>();
process.on("message", (value: unknown) => {
  const command = value as { type: string };
  const resolve = waiting.get(command.type);
  if (resolve) { waiting.delete(command.type); resolve(value); }
  else commands.set(command.type, value);
});
function receive(type: string): Promise<unknown> {
  if (commands.has(type)) {
    const value = commands.get(type);
    commands.delete(type);
    return Promise.resolve(value);
  }
  return new Promise(resolve => waiting.set(type, resolve));
}
function emit(type: string, data: Record<string, unknown> = {}): void {
  process.send?.({ type, pid: process.pid, ...data });
}

let orm: MikroORM | undefined;
let client: SQSClient | undefined;
try {
  const job = await receive("init") as WorkerJob;
  orm = await MikroORM.init({ ...ormConfig, ...(job.mode === "publisher" ? { schema: job.schema } : {}) });
  emit("ready");
  await receive("start");
  if (job.mode === "financial") {
    const delegate = new MikroOrmUnitOfWork(orm.em);
    let announced = false;
    const uow: UnitOfWork = {
      execute: work => delegate.execute(async context => {
        if (!announced) { announced = true; emit("started"); }
        return work(context);
      }),
    };
    const useCase = new ProcessBetUseCase(uow, new MikroOrmWagerTransactionRepository(), new MikroOrmWalletRepository(),
      new MikroOrmLedgerRepository(), new MikroOrmOutboxRepository(), { generate: randomUUID }, new MikroOrmInboxRepository());
    const results = await Promise.all(job.inputs.map(async input => {
      const result = await useCase.execute({ ...input, money: Money.from(input.money), now: new Date(),
        inbox: { ...input.inbox, receivedAt: new Date() } });
      return { ...result, balance: result.balance?.toJSON() };
    }));
    emit("done", { results });
  } else {
    client = createTestSqsClient(1);
    const delegate = new SqsEventPublisher(client, job.queueUrl);
    const attempted: string[] = [];
    const publisher = new PublishOutboxUseCase(new MikroOrmPublishableOutboxRepository(orm.em), {
      publish: async message => {
        if (attempted.length === 0) {
          emit("claimed");
          await receive("publish");
        }
        attempted.push(message.id);
        await delegate.publish(message);
      },
    });
    const result = await publisher.execute(new Date(), 5);
    emit("done", { result, attempted });
  }
} catch (error) {
  emit("failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await orm?.close(true);
  client?.destroy();
  process.disconnect?.();
}
