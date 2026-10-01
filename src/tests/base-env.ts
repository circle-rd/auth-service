/**
 * Applies the minimal environment required by `src/config.ts` for tests.
 *
 * `config.ts` fails fast at import time when required variables are missing.
 * Vitest's `globalSetup` runs before per-file `setupFiles`, and it imports
 * `migrate.ts` (which imports `config.ts`), so both phases must provision
 * these base variables. `DATABASE_URL` is deliberately not set here: the
 * integration global setup provides the real container URL, and the unit
 * setup provides a static placeholder.
 */
export function applyBaseEnv(): void {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-that-is-long-enough";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
  process.env.NODE_ENV ??= "test";
}
