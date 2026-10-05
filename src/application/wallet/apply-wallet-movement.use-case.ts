import { DomainError } from "../../domain/shared/domain-error";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { LedgerDirection, Wallet } from "../../domain/wallet/wallet";
import { Money } from "../../domain/money/money";
import { UnitOfWork } from "../shared/unit-of-work";
import { IdGenerator, LedgerRepository, WalletRepository } from "./ports";

export interface ApplyWalletMovementInput {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  now: Date;
}

export interface ApplyWalletMovementOutput {
  wallet: Wallet;
  ledgerEntry: WalletLedgerEntry;
}

/**
 * Coordinates the aggregate mutation and its audit entry inside one unit of work.
 * Infrastructure decides how the transaction and row lock are implemented.
 */
export class ApplyWalletMovementUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: ApplyWalletMovementInput): Promise<ApplyWalletMovementOutput> {
    return this.unitOfWork.execute(async (context) => {
      const wallet = await this.wallets.findByIdForUpdate(input.walletId, context);

      if (!wallet) {
        throw new DomainError("WALLET_NOT_FOUND", "Wallet was not found");
      }

      const change =
        input.direction === LedgerDirection.Debit
          ? wallet.debit(input.money, input.now)
          : wallet.credit(input.money, input.now);

      const ledgerEntry = WalletLedgerEntry.create({
        id: this.ids.generate(),
        walletId: wallet.id,
        transactionId: input.transactionId,
        direction: change.direction,
        money: change.money,
        balanceBefore: change.balanceBefore,
        balanceAfter: change.balanceAfter,
        createdAt: input.now,
      });

      await this.wallets.save(wallet, context);
      await this.ledger.insert(ledgerEntry, context);

      return { wallet, ledgerEntry };
    });
  }
}
