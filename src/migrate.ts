import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Apply pending Drizzle migrations at startup. The migrations folder is the
 * single source of truth: until the first production deploy a schema change is
 * either inlined into the consolidated `0000` baseline or shipped as a normal
 * delta (AGENTS.md §8 allows both), so no history reconciliation is needed
 * here — a fresh database applies whatever the folder contains, in order.
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = join(__dirname, "..", "drizzle");
  try {
    await migrate(db, { migrationsFolder });
  } catch (err) {
    // A database initialised before the baseline was last regenerated still
    // carries the previous baseline hash, so Drizzle re-runs the baseline and
    // hits an "already exists" error. Surface a clear instruction instead of a
    // raw Postgres error.
    if (err instanceof Error && /already exists/i.test(err.message)) {
      throw new Error(
        "Migrations failed: the database schema already exists but is not " +
          "recorded as migrated. This release regenerates the schema baseline; " +
          "recreate the database before starting (docker compose down -v). " +
          "See the deployment notes in the project roadmap (docs).",
        { cause: err },
      );
    }
    throw err;
  }
}
