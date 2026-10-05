import { Migration } from "@mikro-orm/migrations";

export class Migration20261003150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR(100) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id)
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql("DROP TABLE inbox_messages;");
  }
}
