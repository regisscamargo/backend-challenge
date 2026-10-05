import { EntityManager } from "@mikro-orm/postgresql";

/**
 * Test infrastructure only. PostgreSQL superuser scope is local to this
 * transaction and never appears in application code or production setup.
 */
export async function cleanupWithTriggersDisabled(
  entityManager: EntityManager,
  work: (em: EntityManager) => Promise<void>,
): Promise<void> {
  await entityManager.fork().transactional(async em => {
    await em.getConnection().execute("SET LOCAL session_replication_role = 'replica'", [], "run", em.getTransactionContext());
    await work(em);
  });
}
