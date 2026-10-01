/**
 * Vitest setupFiles for the unit suite — no external services.
 *
 * `src/config.ts` fails fast at import time when required variables are
 * missing. Unit tests must therefore provide a minimal, self-contained
 * environment instead of relying on a local `.env` file, which is absent in
 * CI and would otherwise make `process.exit(1)` abort the test run.
 *
 * `dotenv/config` (imported by `config.ts`) does not override variables that
 * are already set, so these values remain authoritative for the suite.
 */
process.env.BETTER_AUTH_SECRET ??= "unit-test-secret-that-is-long-enough";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/db";
process.env.NODE_ENV ??= "test";
