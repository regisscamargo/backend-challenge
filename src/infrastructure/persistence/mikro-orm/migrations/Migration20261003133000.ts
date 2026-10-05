import { Migration } from "@mikro-orm/migrations";

export class Migration20261003133000 extends Migration {
  override async up(): Promise<void> {
    this.addSql("ALTER TABLE wager_transactions ADD COLUMN response_balance_amount NUMERIC(15,2);");
    this.addSql("ALTER TABLE wager_transactions ADD COLUMN response_balance_currency CHAR(3);");
  }

  override async down(): Promise<void> {
    this.addSql("ALTER TABLE wager_transactions DROP COLUMN response_balance_currency;");
    this.addSql("ALTER TABLE wager_transactions DROP COLUMN response_balance_amount;");
  }
}
