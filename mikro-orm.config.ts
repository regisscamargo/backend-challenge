import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { LedgerEntryOrmEntity } from "./src/infrastructure/persistence/mikro-orm/entities/ledger-entry.orm-entity.js";
import { WalletOrmEntity } from "./src/infrastructure/persistence/mikro-orm/entities/wallet.orm-entity.js";
import { WagerTransactionOrmEntity } from "./src/infrastructure/persistence/mikro-orm/entities/wager-transaction.orm-entity.js";
import { OutboxMessageOrmEntity } from "./src/infrastructure/persistence/mikro-orm/entities/outbox-message.orm-entity.js";
import { InboxMessageOrmEntity } from "./src/infrastructure/persistence/mikro-orm/entities/inbox-message.orm-entity.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be configured through the environment");

export default defineConfig({
  driver: PostgreSqlDriver,
  clientUrl: databaseUrl,
  entities: [
    WalletOrmEntity,
    WagerTransactionOrmEntity,
    LedgerEntryOrmEntity,
    OutboxMessageOrmEntity,
    InboxMessageOrmEntity,
  ],
  extensions: [Migrator],
  migrations: {
    path: "./dist/infrastructure/persistence/mikro-orm/migrations",
    pathTs: "./src/infrastructure/persistence/mikro-orm/migrations",
    glob: "!(*.d).{js,ts}",
    transactional: true,
    allOrNothing: true,
    emit: "ts",
  },
});
