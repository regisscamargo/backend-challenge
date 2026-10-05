import { EntityManager } from "@mikro-orm/postgresql";
import { ClaimableOutboxRepository } from "../../../../application/outbox/publisher-ports";
import { OutboxMessage } from "../../../../domain/outbox/outbox-message";
import { OutboxMessageOrmEntity } from "../entities/outbox-message.orm-entity";
import { OutboxMessageMapper } from "../mappers/outbox-message.mapper";

export class MikroOrmPublishableOutboxRepository implements ClaimableOutboxRepository {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly leaseMs = 60_000,
  ) {}

  async claimDue(now: Date, workerId: string, limit: number): Promise<OutboxMessage[]> {
    return this.entityManager.fork().transactional(async (em) => {
      const staleBefore = new Date(now.getTime() - this.leaseMs);
      const schema = em.config.getSchema() ?? "public";
      const table = `"${schema.replaceAll('"', '""')}"."outbox_messages"`;
      const claimed = await em.getConnection().execute<{ id: string }[]>(`
        WITH candidates AS (
          SELECT candidate.id
          FROM ${table} AS candidate
          WHERE candidate.published_at IS NULL
            AND (candidate.locked_at IS NULL OR candidate.locked_at <= ?)
            AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?)
            AND NOT EXISTS (
              SELECT 1
              FROM ${table} AS earlier
              WHERE earlier.aggregate_id = candidate.aggregate_id
                AND earlier.published_at IS NULL
                AND (
                  COALESCE((earlier.payload #>> '{data,walletVersion}')::bigint, 0), earlier.occurred_at, earlier.id
                ) < (
                  COALESCE((candidate.payload #>> '{data,walletVersion}')::bigint, 0), candidate.occurred_at, candidate.id
                )
            )
          ORDER BY COALESCE((candidate.payload #>> '{data,walletVersion}')::bigint, 0),
            candidate.occurred_at ASC, candidate.id ASC
          FOR UPDATE OF candidate SKIP LOCKED
          LIMIT ?
        )
        UPDATE ${table} AS message
        SET locked_at = ?, locked_by = ?
        FROM candidates
        WHERE message.id = candidates.id
        RETURNING message.id
      `, [staleBefore, now, limit, new Date(), workerId], "all", em.getTransactionContext());

      if (claimed.length === 0) return [];
      const records = await em.find(OutboxMessageOrmEntity, {
        id: { $in: claimed.map((record) => record.id) },
        lockedBy: workerId,
        publishedAt: null,
      }, { orderBy: { occurredAt: "ASC", id: "ASC" } });
      return records.map(OutboxMessageMapper.toDomain);
    });
  }

  async markPublished(id: string, workerId: string, at: Date): Promise<void> {
    await this.entityManager.fork().nativeUpdate(
      OutboxMessageOrmEntity,
      { id, lockedBy: workerId, publishedAt: null },
      { publishedAt: at, lockedAt: null, lockedBy: null },
    );
  }

  async markPublishedBatch(ids: readonly string[], workerId: string, at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.entityManager.fork().nativeUpdate(
      OutboxMessageOrmEntity,
      { id: { $in: [...ids] }, lockedBy: workerId, publishedAt: null },
      { publishedAt: at, lockedAt: null, lockedBy: null },
    );
  }

  async scheduleRetry(id: string, workerId: string, now: Date, errorMessage: string): Promise<void> {
    await this.entityManager.fork().transactional(async (em) => {
      const record = await em.findOne(OutboxMessageOrmEntity, {
        id,
        lockedBy: workerId,
        publishedAt: null,
      });

      if (!record) {
        return;
      }

      const message = OutboxMessageMapper.toDomain(record);
      message.scheduleRetry(now);
      record.attempts = message.attempts;
      record.nextAttemptAt = message.nextAttemptAt ?? null;
      record.lockedAt = null;
      record.lockedBy = null;
      record.lastError = errorMessage;
      await em.flush();
    });
  }
}
