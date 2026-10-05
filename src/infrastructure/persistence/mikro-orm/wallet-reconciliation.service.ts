import { Injectable } from "@nestjs/common";
import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { DomainError } from "../../../domain/shared/domain-error";
import { Money } from "../../../domain/money/money";
import { WalletOrmEntity } from "./entities/wallet.orm-entity";
import { TelemetryService } from "../../observability/telemetry.service";

@Injectable()
export class WalletReconciliationService {
  private divergences = 0;

  constructor(private readonly entityManager: EntityManager, private readonly telemetry: TelemetryService = new TelemetryService()) {}

  get divergenceCount(): number { return this.divergences; }

  async execute(walletId: string, correlationId: string) {
    const result = await this.entityManager.fork().transactional(async (em) => {
      // Shared row lock allows parallel checks but blocks wallet movements
      // until the ledger sum and stored balance have both been read.
      const wallet = await em.findOne(WalletOrmEntity, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_READ });
      if (!wallet) throw new DomainError("WALLET_NOT_FOUND", "Wallet was not found");
      const rows = await em.getConnection().execute<{
        total: string; checked: string; currency_mismatches: string;
      }[]>(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS total,
         COUNT(*)::text AS checked,
         COUNT(*) FILTER (WHERE currency <> ?)::text AS currency_mismatches
         FROM wallet_ledger_entries WHERE wallet_id = ?`, [wallet.currency, walletId], "all", em.getTransactionContext(),
      );
      const row = rows[0];
      if (!row) throw new Error("Reconciliation aggregate returned no result");
      const storedBalance = Money.from({ amount: wallet.balance, currency: wallet.currency });
      const calculatedBalance = Money.from({ amount: row.total, currency: wallet.currency });
      const difference = storedBalance.subtract(calculatedBalance);
      return {
        walletId, storedBalance: storedBalance.toJSON(), calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(), consistent: difference.isZero() && row.currency_mismatches === "0",
        checkedEntries: Number(row.checked), currencyMismatchEntries: Number(row.currency_mismatches),
      };
    });
    if (!result.consistent) {
      this.divergences += 1;
      this.telemetry.divergences.inc();
      process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level: "error",
        event: "wallet_reconciliation_divergence", walletId, correlationId,
        checkedEntries: result.checkedEntries, currencyMismatchEntries: result.currencyMismatchEntries }) + "\n");
    }
    return result;
  }
}
