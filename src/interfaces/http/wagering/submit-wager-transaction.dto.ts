import { Type } from "class-transformer";
import { IsEnum, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, ValidateNested } from "class-validator";
import { WagerTransactionKind } from "../../../domain/wagering/wager-transaction";

export class MoneyDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^(?:0|[1-9]\d{0,12})\.\d{2}$/)
  amount!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class SubmitWagerTransactionDto {
  @IsString()
  @IsNotEmpty()
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  externalTransactionId!: string;

  @IsString()
  @IsNotEmpty()
  @IsUUID()
  playerId!: string;

  @IsString()
  @IsNotEmpty()
  @IsUUID()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  gameId!: string;

  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @IsString()
  @IsOptional()
  referenceExternalTransactionId?: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsISO8601()
  @IsOptional()
  occurredAt?: string;
}
