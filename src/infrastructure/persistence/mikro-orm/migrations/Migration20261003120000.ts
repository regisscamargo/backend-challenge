import { Migration } from "@mikro-orm/migrations";

export class Migration20261003120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency CHAR(3) NOT NULL,
        balance NUMERIC(15, 2) NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(100) NOT NULL,
        external_transaction_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id UUID NOT NULL,
        round_id VARCHAR(255) NOT NULL,
        game_id VARCHAR(255) NOT NULL,
        kind VARCHAR(16) NOT NULL,
        amount NUMERIC(15, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        status VARCHAR(32) NOT NULL,
        reference_external_transaction_id VARCHAR(255),
        reference_transaction_id UUID,
        failure_code VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        CONSTRAINT wager_transactions_kind_check CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_check CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_transactions_amount_positive CHECK (amount > 0),
        CONSTRAINT wager_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_transactions_idempotency_unique UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_transactions_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_reference_fk FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions(id)
      );
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
        direction VARCHAR(6) NOT NULL,
        amount NUMERIC(15, 2) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_before NUMERIC(15, 2) NOT NULL,
        balance_after NUMERIC(15, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT wallet_ledger_direction_check CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT wallet_ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT wallet_ledger_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallet_ledger_arithmetic_check CHECK (
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
          OR
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
        ),
        CONSTRAINT wallet_ledger_transaction_unique UNIQUE (wallet_id, transaction_id)
      );
    `);

    this.addSql("CREATE INDEX wallets_player_id_idx ON wallets (player_id);");
    this.addSql("CREATE INDEX wager_transactions_wallet_id_idx ON wager_transactions (wallet_id, created_at);");
    this.addSql("CREATE INDEX wager_transactions_reference_idx ON wager_transactions (provider_id, reference_external_transaction_id);");
    this.addSql("CREATE INDEX wallet_ledger_wallet_cursor_idx ON wallet_ledger_entries (wallet_id, created_at, id);");
  }

  override async down(): Promise<void> {
    this.addSql("DROP TABLE wallet_ledger_entries;");
    this.addSql("DROP TABLE wager_transactions;");
    this.addSql("DROP TABLE wallets;");
  }
}
