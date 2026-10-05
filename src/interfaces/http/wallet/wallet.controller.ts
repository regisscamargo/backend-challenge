import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { WageringQueries } from "../../../infrastructure/persistence/mikro-orm/wagering-queries";
import { LedgerQueryDto } from "./ledger-query.dto";
import { IsDefined, IsUUID, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { MoneyDto } from "../wagering/submit-wager-transaction.dto";
import { Money } from "../../../domain/money/money";
import { CreateWalletUseCase } from "../../../application/wallet/create-wallet.use-case";
import { randomUUID } from "node:crypto";
import { WalletReconciliationService } from "../../../infrastructure/persistence/mikro-orm/wallet-reconciliation.service";

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

@Controller("wallets")
export class WalletController {
  constructor(private readonly createWallet: CreateWalletUseCase, private readonly queries: WageringQueries,
    private readonly reconciliation: WalletReconciliationService) {}

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId", new ParseUUIDPipe()) walletId: string) {
    return this.reconciliation.execute(walletId, randomUUID());
  }

  @Get(":walletId")
  get(@Param("walletId", new ParseUUIDPipe()) walletId: string) {
    return this.queries.wallet(walletId);
  }

  @Get(":walletId/ledger")
  ledger(@Param("walletId", new ParseUUIDPipe()) walletId: string, @Query() query: LedgerQueryDto) {
    return this.queries.ledger(walletId, query.limit ?? 50, query.cursor);
  }

  @Post()
  async create(@Body() body: CreateWalletDto) {
    const wallet = await this.createWallet.execute({
      playerId: body.playerId, initialBalance: Money.from(body.initialBalance), now: new Date(),
    });
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}
