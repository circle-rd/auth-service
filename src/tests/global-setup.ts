/**
 * Vitest global setup — runs ONCE before all integration test files.
 *
 * Starts a PostgreSQL testcontainer, writes the connection URL to a
 * well-known temp file so that `setup-env.ts` (which runs in each worker
 * process) can set process.env.DATABASE_URL before any module is imported.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_FILE = join(tmpdir(), "auth-service-test-db-url.txt");

let container: StartedPostgreSqlContainer;

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("auth_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  const url = container.getConnectionUri();
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(URL_FILE, url, "utf-8");

  // Expose to the main process as well (for globalSetup teardown context)
  process.env.DATABASE_URL = url;

  // Run migrations once
  // Dynamic import AFTER env is set so db/config pick up the correct URL
  const { runMigrations } = await import("../migrate.js");
  await runMigrations();
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
