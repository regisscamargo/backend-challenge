import { Body, Controller, Get, Headers, HttpStatus, Param, ParseUUIDPipe, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { WageringQueries } from "../../../infrastructure/persistence/mikro-orm/wagering-queries";
import { ProcessBetUseCase } from "../../../application/wagering/process-bet.use-case";
import { hashCanonicalPayload } from "../../../application/wagering/payload-hash";
import { Money } from "../../../domain/money/money";
import { DomainError } from "../../../domain/shared/domain-error";
import { SubmitWagerTransactionDto } from "./submit-wager-transaction.dto";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction";

@Controller("wagering")
export class WageringController {
  constructor(private readonly processBet: ProcessBetUseCase, private readonly queries: WageringQueries) {}

  @Get("transactions/:transactionId")
  get(@Param("transactionId", new ParseUUIDPipe()) id: string) {
    return this.queries.transaction({ id });
  }

  @Post("transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: SubmitWagerTransactionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) {
      throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
    }

    const money = Money.from(body.money);
    const businessPayload = {
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      ...(body.referenceExternalTransactionId
        ? { referenceExternalTransactionId: body.referenceExternalTransactionId }
        : {}),
      money: money.toJSON(),
    };
    const result = await this.processBet.execute({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      idempotencyKey,
      payloadHash: hashCanonicalPayload(businessPayload),
      walletId: body.walletId,
      playerId: body.playerId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      ...(body.referenceExternalTransactionId
        ? { referenceExternalTransactionId: body.referenceExternalTransactionId }
        : {}),
      money,
      now: body.occurredAt ? new Date(body.occurredAt) : new Date(),
    });

    response.status(
      result.status === WagerTransactionStatus.PendingReference
        ? HttpStatus.ACCEPTED
        : result.status === WagerTransactionStatus.Rejected
          ? HttpStatus.UNPROCESSABLE_ENTITY
          : HttpStatus.CREATED,
    );

    return {
      transactionId: result.transactionId,
      status: result.status,
      ...(result.balance ? { balance: result.balance.toJSON() } : {}),
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      idempotentReplay: result.idempotentReplay,
    };
  }
}

@Controller("providers")
export class ProviderTransactionsController {
  constructor(private readonly queries: WageringQueries) {}

  @Get(":providerId/wagering/transactions/:externalTransactionId")
  get(@Param("providerId") providerId: string, @Param("externalTransactionId") externalTransactionId: string) {
    return this.queries.transaction({ providerId, externalTransactionId });
  }
}
