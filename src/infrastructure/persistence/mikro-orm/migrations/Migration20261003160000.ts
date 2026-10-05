import { Migration } from "@mikro-orm/migrations";

export class Migration20261003160000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN reference_attempts INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN reference_next_attempt_at TIMESTAMPTZ;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP COLUMN reference_attempts,
        DROP COLUMN reference_next_attempt_at;
    `);
  }
}
