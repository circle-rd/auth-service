import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Apply pending Drizzle migrations at startup. The migrations folder is the
 * single source of truth: until the first production deploy the consolidated
 * baseline is regenerated (see AGENTS.md §8), so no history reconciliation is
 * needed here — a fresh database simply applies the baseline in one go.
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = join(__dirname, "..", "drizzle");
  try {
    await migrate(db, { migrationsFolder });
  } catch (err) {
    // The consolidated baseline is regenerated until the first production
    // deploy (AGENTS.md §8). An already-initialised database still carries the
    // previous baseline hash, so Drizzle re-runs the baseline and hits an
    // "already exists" error. Surface a clear instruction instead of a raw
    // Postgres error.
    if (err instanceof Error && /already exists/i.test(err.message)) {
      throw new Error(
        "Migrations failed: the database schema already exists but is not " +
          "recorded as migrated. This release regenerates the schema baseline; " +
          "recreate the database before starting (docker compose down -v). " +
          "See UPGRADE_PLAN.md.",
        { cause: err },
      );
    }
    throw err;
  }
}
