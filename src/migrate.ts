import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Probes that detect whether a post-baseline migration's effects are already
 * present in the database. Used when the DB predates the consolidated 0000
 * baseline AND already has subsequent DDL (e.g. an env that was hand-patched
 * or restored from a `pg_dump` taken after a later migration ran). For each
 * tag, the SQL must return a non-empty result iff the migration is
 * effectively applied.
 *
 * Add a new entry here whenever a migration introduces a uniquely detectable
 * change AND there is a chance some environment received that change outside
 * the drizzle migrator (manual `ALTER`, `db:push`, hotfix, restored dump…).
 * Migrations that ship after a clean baseline and only ever run through this
 * runner do not need a probe.
 */
const POST_BASELINE_PROBES: { tag: string; probe: ReturnType<typeof sql> }[] = [];

/**
 * Ensures `__drizzle_migrations` is consistent with the migrations folder.
 *
 * Two distinct legacy states can produce a stale history table:
 *
 * 1. Pre-consolidation: the DB was migrated through the original (now-deleted)
 *    migrations and `__drizzle_migrations` contains hashes that no longer
 *    exist on disk. Drizzle would re-apply every consolidated migration (all
 *    DDL is `IF NOT EXISTS`-safe in 0000 but not in later files) — and crash.
 *
 * 2. Out-of-band DDL: somebody applied a later migration's DDL via `db:push`
 *    or a manual `ALTER` before that migration existed. The history is empty
 *    or only contains the baseline; drizzle would replay the migration and
 *    crash on the duplicate column / table.
 *
 * Strategy:
 *
 * - If at least one expected hash is already in the history, the DB is on the
 *   current consolidated baseline. Leave the table untouched and let
 *   `migrate()` apply only the genuinely missing deltas.
 *
 * - Otherwise (truly stale or empty history with the consolidated tables
 *   present), reset the history to the baseline and additionally mark every
 *   post-baseline migration whose effect is already detectable in the DB.
 *
 * - On a fresh install, the history table does not exist yet and this is a
 *   no-op — `migrate()` will create the table and apply everything.
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
      tag: entry.tag,
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

    // The history already contains at least one current hash → the DB is on
    // the consolidated baseline and just needs the new deltas. Leaving the
    // table alone is critical: wiping it would force a re-apply of migrations
    // that have already run successfully.
    const someApplied = expectedMigrations.some((m) => appliedHashes.has(m.hash));
    if (someApplied) return;

    // Confirm tables actually exist before deciding this is a pre-consolidation
    // DB (not a partial/corrupt state).
    const check = (await db.execute(
      sql`SELECT to_regclass('public.app_permissions') AS tbl`,
    )) as { tbl: string | null }[];
    if (!check[0]?.tbl) return;

    // Stale entries confirmed. Mark the baseline as applied, then probe for
    // any post-baseline migration whose effect is already physically present
    // and mark it too — replaying its DDL would crash on duplicates.
    const baseline = expectedMigrations[0];
    if (!baseline) return;

    const tagsAlreadyEffective = new Set<string>([baseline.tag]);
    for (const { tag, probe } of POST_BASELINE_PROBES) {
      const result = (await db.execute(probe)) as unknown[];
      if (result.length > 0) tagsAlreadyEffective.add(tag);
    }

    await db.execute(sql`DELETE FROM drizzle.__drizzle_migrations`);
    for (const m of expectedMigrations) {
      if (!tagsAlreadyEffective.has(m.tag)) continue;
      await db.execute(
        sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
            VALUES (${m.hash}, ${m.folderMillis})`,
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
