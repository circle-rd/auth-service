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
  await migrate(db, { migrationsFolder });
}
