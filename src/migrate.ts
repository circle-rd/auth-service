import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Ensures `__drizzle_migrations` is consistent with the migrations folder.
 *
 * When deploying onto a database that was migrated before the consolidation
 * into a single `0000_initial_schema.sql`, the migration table contains old
 * hashes. Drizzle would then attempt to re-apply every migration in the
 * journal (by hash comparison) and crash — even though all DDL uses IF NOT
 * EXISTS — because Drizzle wraps the file in a transaction.
 *
 * This function:
 * 1. Reads the journal to discover current migration hashes (identical logic
 *    to drizzle-orm's internal readMigrationFiles).
 * 2. If __drizzle_migrations is non-empty but doesn't contain those hashes,
 *    and the tables already exist, replaces the stale entries.
 * 3. Is a no-op on fresh installs (table doesn't exist yet).
 */
async function normalizeMigrationHistory(migrationsFolder: string): Promise<void> {
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
    entries: { tag: string; when: number; breakpoints: boolean }[];
  };

  // Compute hashes the same way drizzle-orm does: SHA-256 of raw file content.
  const expectedMigrations = journal.entries.map((entry) => {
    const content = readFileSync(join(migrationsFolder, `${entry.tag}.sql`), "utf-8");
    return {
      hash: createHash("sha256").update(content).digest("hex"),
      folderMillis: entry.when,
    };
  });

  try {
    const rows = (await db.execute(
      sql`SELECT hash FROM drizzle.__drizzle_migrations`,
    )) as { hash: string }[];

    // Fresh database — migrator will create the table and apply normally.
    if (rows.length === 0) return;

    const appliedHashes = new Set(rows.map((r) => r.hash));
    const allApplied = expectedMigrations.every((m) => appliedHashes.has(m.hash));
    if (allApplied) return;

    // Some expected hashes are missing. Confirm tables actually exist before
    // deciding this is a pre-consolidation DB (not a partial/corrupt state).
    const check = (await db.execute(
      sql`SELECT to_regclass('public.app_permissions') AS tbl`,
    )) as { tbl: string | null }[];
    if (!check[0]?.tbl) return;

    // Stale entries confirmed — replace with the current migration set.
    await db.execute(sql`DELETE FROM drizzle.__drizzle_migrations`);
    for (const migration of expectedMigrations) {
      await db.execute(
        sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
            VALUES (${migration.hash}, ${migration.folderMillis})`,
      );
    }
  } catch {
    // drizzle schema / table does not exist yet — fresh install, nothing to do.
  }
}

export async function runMigrations(): Promise<void> {
  const migrationsFolder = join(__dirname, "..", "drizzle");
  await normalizeMigrationHistory(migrationsFolder);
  await migrate(db, { migrationsFolder });
}

/**
 * Ensures `__drizzle_migrations` is consistent with the consolidated schema file.
 *
 * When updating from a database that was migrated before the consolidation
 * (multiple incremental files → single 0000_initial_schema.sql), the migration
 * table contains old hashes that Drizzle no longer recognises. Drizzle would
 * then attempt to re-apply the consolidated file and crash on already-existing
 * tables — even though all DDL statements use IF NOT EXISTS — because the whole
 * file runs inside a transaction and PostgreSQL aborts on the first error.
 *
 * This function detects stale entries and replaces them with the hash of the
 * current consolidated file so Drizzle treats it as already applied.
 */
async function normalizeMigrationHistory(migrationsFolder: string): Promise<void> {
  const sqlFilePath = join(migrationsFolder, "0000_initial_schema.sql");
  const content = readFileSync(sqlFilePath, "utf-8");
  const expectedHash = createHash("sha256").update(content).digest("hex");

  try {
    const rows = await db.execute(
      sql`SELECT hash FROM drizzle.__drizzle_migrations`,
    );

    // Fresh database — let the migrator create the table and apply normally.
    if (rows.length === 0) return;

    // Already normalised — nothing to do.
    const alreadyCorrect = rows.some(
      (r: Record<string, unknown>) => r["hash"] === expectedHash,
    );
    if (alreadyCorrect) return;

    // Stale entries from pre-consolidation migrations — replace with the
    // consolidated migration so Drizzle skips it on the next run.
    await db.execute(sql`DELETE FROM drizzle.__drizzle_migrations`);
    await db.execute(
      sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${expectedHash}, ${Date.now()})`,
    );
  } catch {
    // drizzle schema / table does not exist yet — fresh install, no action needed.
  }
}

export async function runMigrations(): Promise<void> {
  const migrationsFolder = join(__dirname, "..", "drizzle");
  await normalizeMigrationHistory(migrationsFolder);
  await migrate(db, { migrationsFolder });
}
