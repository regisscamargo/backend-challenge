import { expect, test } from "bun:test";
import { OutboxMessage } from "../../src/domain/outbox/outbox-message";
import { PublishOutboxUseCase } from "../../src/application/outbox/publish-outbox.use-case";
import type { ClaimableOutboxRepository, EventPublisher } from "../../src/application/outbox/publisher-ports";

function message(id: string, aggregateId = id) {
  return OutboxMessage.rehydrate({ id, aggregateId, eventType: "TestEvent", payload: { eventId: id },
    occurredAt: new Date("2026-10-03T12:00:00.000Z"), attempts: 0 });
}

test("outbox batch publisher persists successful entries and schedules only partial failures", async () => {
  const messages = [message("event-1", "aggregate-1"), message("event-2", "aggregate-2"), message("event-3", "aggregate-3")];
  const marked: string[][] = [];
  const retried: string[] = [];
  const repository: ClaimableOutboxRepository = {
    claimDue: async () => messages,
    markPublished: async () => { throw new Error("single-message path should not be used"); },
    markPublishedBatch: async ids => { marked.push([...ids]); },
    scheduleRetry: async id => { retried.push(id); },
  };
  const publisher: EventPublisher = {
    publish: async () => { throw new Error("batch path should be used"); },
    publishBatch: async batch => {
      expect(new Set(batch.map(item => item.aggregateId)).size).toBe(batch.length);
      return { publishedMessageIds: ["event-1", "event-3"], failures: [{ messageId: "event-2", reason: "throttled" }] };
    },
  };

  const result = await new PublishOutboxUseCase(repository, publisher).execute(new Date());

  expect(result).toEqual({ claimed: 3, published: 2, scheduledForRetry: 1 });
  expect(marked).toEqual([["event-1", "event-3"]]);
  expect(retried).toEqual(["event-2"]);
});

test("outbox serial fallback keeps messages of an aggregate in order", async () => {
  const messages = [message("event-1", "hot-wallet"), message("event-2", "hot-wallet")];
  const sent: string[] = [];
  const repository: ClaimableOutboxRepository = {
    claimDue: async () => messages,
    markPublished: async id => { sent.push(`ack:${id}`); },
    markPublishedBatch: async () => { throw new Error("single-message path should be used"); },
    scheduleRetry: async () => {},
  };
  const publisher: EventPublisher = { publish: async item => { sent.push(`send:${item.id}`); } };

  await new PublishOutboxUseCase(repository, publisher).execute(new Date());

  expect(sent).toEqual(["send:event-1", "ack:event-1", "send:event-2", "ack:event-2"]);
});
