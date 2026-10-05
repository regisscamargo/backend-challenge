import { Migration } from "@mikro-orm/migrations";

export class Migration20261003190000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE INDEX outbox_aggregate_pending_order_idx
      ON outbox_messages (aggregate_id, occurred_at, id)
      WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql("DROP INDEX outbox_aggregate_pending_order_idx;");
  }
}
