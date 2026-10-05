import { defineEntity, p } from "@mikro-orm/postgresql";

const OutboxMessageSchema = defineEntity({
  name: "OutboxMessageOrmEntity",
  tableName: "outbox_messages",
  properties: {
    id: p.string().type("uuid").primary(),
    aggregateId: p.string().type("uuid"),
    eventType: p.string().length(100),
    payload: p.json(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    publishedAt: p.datetime().nullable(),
    lockedAt: p.datetime().nullable(),
    lockedBy: p.string().length(100).nullable(),
    lastError: p.text().nullable(),
  },
});

export class OutboxMessageOrmEntity extends OutboxMessageSchema.class {}
OutboxMessageSchema.setClass(OutboxMessageOrmEntity);
