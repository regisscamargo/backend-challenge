import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ProcessBetUseCase } from "./process-bet.use-case";
import { MikroOrmUnitOfWork } from "../../infrastructure/persistence/mikro-orm/mikro-orm-unit-of-work";
import { MikroOrmWagerTransactionRepository } from "../../infrastructure/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository";

/** Retries out-of-order dependent transactions without holding DB locks. */
@Injectable()
export class PendingReferenceWorker {
  private running = false;

  constructor(
    private readonly unitOfWork: MikroOrmUnitOfWork,
    private readonly transactions: MikroOrmWagerTransactionRepository,
    private readonly processWager: ProcessBetUseCase,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const pending = await this.unitOfWork.execute((context) =>
        this.transactions.findPendingReferences(50, now, context),
      );
      for (const transaction of pending) {
        if (!transaction.referenceExternalTransactionId) continue;
        await this.processWager.retryPendingReference({
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          idempotencyKey: transaction.idempotencyKey,
          payloadHash: transaction.payloadHash,
          walletId: transaction.walletId,
          playerId: transaction.playerId,
          roundId: transaction.roundId,
          gameId: transaction.gameId,
          kind: transaction.kind,
          referenceExternalTransactionId: transaction.referenceExternalTransactionId,
          money: transaction.money,
          now: new Date(),
        });
      }
    } finally {
      this.running = false;
    }
  }
}
