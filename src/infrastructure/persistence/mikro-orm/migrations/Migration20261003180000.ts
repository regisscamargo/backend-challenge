import { Migration } from "@mikro-orm/migrations";

export class Migration20261003180000 extends Migration {
  override async up(): Promise<void> {
    const role = this.runtimeRoleIdentifier();
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role.literal}) THEN
          REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
            ON TABLE wallet_ledger_entries FROM ${role.identifier};
          GRANT SELECT, INSERT ON TABLE wallet_ledger_entries TO ${role.identifier};
        END IF;
      END
      $$;
    `);
  }

  override async down(): Promise<void> {
    const role = this.runtimeRoleIdentifier();
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role.literal}) THEN
          GRANT SELECT, INSERT, UPDATE ON TABLE wallet_ledger_entries TO ${role.identifier};
        END IF;
      END
      $$;
    `);
  }

  private runtimeRoleIdentifier(): { identifier: string; literal: string } {
    const role = process.env.APP_DB_USER;
    if (!role) throw new Error("APP_DB_USER must be configured before running this migration");
    return {
      identifier: `"${role.replaceAll('"', '""')}"`,
      literal: `'${role.replaceAll("'", "''")}'`,
    };
  }
}
