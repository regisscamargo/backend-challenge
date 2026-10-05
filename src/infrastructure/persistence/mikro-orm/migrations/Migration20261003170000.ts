import { Migration } from "@mikro-orm/migrations";

export class Migration20261003170000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION reject_wallet_ledger_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only'
          USING ERRCODE = 'P0001';
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql("DROP TRIGGER wallet_ledger_entries_append_only ON wallet_ledger_entries;");
    this.addSql("DROP FUNCTION reject_wallet_ledger_mutation();");
  }
}
