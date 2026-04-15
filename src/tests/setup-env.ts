/**
 * Vitest setupFiles — runs in every worker process before tests.
 *
 * Reads the PostgreSQL connection URL written by global-setup.ts and sets
 * process.env.DATABASE_URL so that src/config.ts and src/db/index.ts pick
 * up the correct URL when they are first imported by a test file.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_FILE = join(tmpdir(), "auth-service-test-db-url.txt");

const url = readFileSync(URL_FILE, "utf-8").trim();
process.env.DATABASE_URL = url;

// Provide the remaining env vars that config.ts requires
process.env.BETTER_AUTH_SECRET = "integration-test-secret-that-is-long-enough";
process.env.BETTER_AUTH_URL = "http://localhost:3001";
process.env.NODE_ENV = "test";
