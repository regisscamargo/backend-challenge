import { defineEntity, p } from "@mikro-orm/postgresql";

const InboxMessageSchema = defineEntity({
  name: "InboxMessageOrmEntity",
  tableName: "inbox_messages",
  properties: {
    messageId: p.string().length(255).primary(),
    consumerName: p.string().length(100).primary(),
    payloadHash: p.string().length(64),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});

export class InboxMessageOrmEntity extends InboxMessageSchema.class {}
InboxMessageSchema.setClass(InboxMessageOrmEntity);
