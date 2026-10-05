import { DomainError } from "../../../domain/shared/domain-error";
import { EntityManager } from "@mikro-orm/postgresql";
import { TransactionContext } from "../../../application/shared/unit-of-work";

export function requireEntityManager(context: TransactionContext): EntityManager {
  if (!(context.transaction instanceof EntityManager)) {
    throw new DomainError(
      "MISSING_DATABASE_TRANSACTION",
      "A MikroORM transaction is required",
    );
  }

  return context.transaction;
}
