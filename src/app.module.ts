import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { SQSClient } from "@aws-sdk/client-sqs";
import ormConfig from "../mikro-orm.config";
import { ProcessBetUseCase } from "./application/wagering/process-bet.use-case";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm/mikro-orm-unit-of-work";
import { MikroOrmWalletRepository } from "./infrastructure/persistence/mikro-orm/repositories/mikro-orm-wallet.repository";
import { MikroOrmLedgerRepository } from "./infrastructure/persistence/mikro-orm/repositories/mikro-orm-ledger.repository";
import { MikroOrmWagerTransactionRepository } from "./infrastructure/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmOutboxRepository } from "./infrastructure/persistence/mikro-orm/repositories/mikro-orm-outbox.repository";
import { MikroOrmInboxRepository } from "./infrastructure/persistence/mikro-orm/repositories/mikro-orm-inbox.repository";
import { NoopAuthGuard } from "./interfaces/http/auth/noop-auth.guard";
import { DomainErrorFilter } from "./interfaces/http/errors/domain-error.filter";
import { HealthController, ReadinessProbe, SQS_CLIENT, SQS_TRANSACTIONS_QUEUE_URL } from "./interfaces/http/health/health.controller";
import { WageringController, ProviderTransactionsController } from "./interfaces/http/wagering/wagering.controller";
import { WageringQueries } from "./infrastructure/persistence/mikro-orm/wagering-queries";
import { PendingReferenceWorker } from "./application/wagering/pending-reference.worker";
import { CreateWalletUseCase } from "./application/wallet/create-wallet.use-case";
import { WalletController } from "./interfaces/http/wallet/wallet.controller";
import { WalletReconciliationService } from "./infrastructure/persistence/mikro-orm/wallet-reconciliation.service";
import { TelemetryService } from "./infrastructure/observability/telemetry.service";
import { MetricsController } from "./interfaces/http/metrics/metrics.controller";
import { MikroORM } from "@mikro-orm/postgresql";
import { MikroOrmPublishableOutboxRepository } from "./infrastructure/persistence/mikro-orm/repositories/mikro-orm-publishable-outbox.repository";
import { PublishOutboxUseCase } from "./application/outbox/publish-outbox.use-case";
import { SqsEventPublisher } from "./infrastructure/messaging/sqs/sqs-event.publisher";
import { SqsWagerTransactionConsumer } from "./infrastructure/messaging/sqs/sqs-wager-transaction.consumer";
import { MessagingRuntime } from "./infrastructure/messaging/sqs/messaging-runtime";
import { DemoController } from "./interfaces/http/demo/demo.controller";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

const SQS_QUEUE_URL = requiredEnv("SQS_WAGER_TRANSACTIONS_QUEUE_URL");
const SQS_EVENTS_QUEUE_URL = requiredEnv("SQS_WAGER_EVENTS_QUEUE_URL");

function createSqsClient(): SQSClient {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  return new SQSClient({
    region: requiredEnv("AWS_REGION"),
    ...(endpoint ? { endpoint } : {}),
  });
}

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig), ScheduleModule.forRoot()],
  controllers: [WageringController, HealthController, WalletController, ProviderTransactionsController, MetricsController, DemoController],
  providers: [
    { provide: APP_GUARD, useClass: NoopAuthGuard },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
    { provide: SQS_CLIENT, useFactory: createSqsClient },
    { provide: SQS_TRANSACTIONS_QUEUE_URL, useValue: SQS_QUEUE_URL },
    ReadinessProbe,
    TelemetryService,
    WageringQueries,
    WalletReconciliationService,
    MikroOrmUnitOfWork,
    MikroOrmWalletRepository,
    MikroOrmLedgerRepository,
    MikroOrmWagerTransactionRepository,
    MikroOrmOutboxRepository,
    MikroOrmInboxRepository,
    PendingReferenceWorker,
    {
      provide: MessagingRuntime,
      inject: [MikroORM, SQS_CLIENT, ProcessBetUseCase, TelemetryService],
      useFactory: (orm: MikroORM, client: SQSClient, processBet: ProcessBetUseCase, telemetry: TelemetryService) =>
        new MessagingRuntime(
          new SqsWagerTransactionConsumer(client, SQS_QUEUE_URL, processBet, {
            consumerName: "wager-processor", visibilityTimeoutSeconds: 60,
            maxNumberOfMessages: 1,
            onFailure: () => telemetry.retry("sqs"),
          }),
          new PublishOutboxUseCase(new MikroOrmPublishableOutboxRepository(orm.em),
              new SqsEventPublisher(client, SQS_EVENTS_QUEUE_URL), telemetry),
          () => telemetry.retry("outbox"),
        ),
    },
    {
      provide: CreateWalletUseCase,
      useFactory: (uow: MikroOrmUnitOfWork, wallets: MikroOrmWalletRepository,
        transactions: MikroOrmWagerTransactionRepository, ledger: MikroOrmLedgerRepository,
        outbox: MikroOrmOutboxRepository) => new CreateWalletUseCase(
          uow, wallets, transactions, ledger, outbox, { generate: randomUUID },
        ),
      inject: [MikroOrmUnitOfWork, MikroOrmWalletRepository, MikroOrmWagerTransactionRepository,
        MikroOrmLedgerRepository, MikroOrmOutboxRepository],
    },
    {
      provide: ProcessBetUseCase,
      useFactory: (
        unitOfWork: MikroOrmUnitOfWork,
        transactions: MikroOrmWagerTransactionRepository,
        wallets: MikroOrmWalletRepository,
        ledger: MikroOrmLedgerRepository,
        outbox: MikroOrmOutboxRepository,
        inbox: MikroOrmInboxRepository,
        telemetry: TelemetryService,
      ) => new ProcessBetUseCase(
        unitOfWork,
        transactions,
        wallets,
        ledger,
        outbox,
        { generate: randomUUID },
        inbox,
        telemetry,
      ),
      inject: [
        MikroOrmUnitOfWork,
        MikroOrmWagerTransactionRepository,
        MikroOrmWalletRepository,
        MikroOrmLedgerRepository,
        MikroOrmOutboxRepository,
        MikroOrmInboxRepository,
        TelemetryService,
      ],
    },
  ],
})
export class AppModule {}
