import { Migration } from "@mikro-orm/migrations";

export class Migration20261003140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        locked_at TIMESTAMPTZ,
        locked_by VARCHAR(100),
        last_error TEXT,
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
      );
    `);
    this.addSql(
      "CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at, occurred_at) WHERE published_at IS NULL;",
    );
  }

  override async down(): Promise<void> {
    this.addSql("DROP TABLE outbox_messages;");
  }
}
