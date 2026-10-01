/**
 * Vitest setupFiles for the unit suite — no external services.
 *
 * Unit tests must provide a self-contained environment instead of relying on
 * a local `.env` file, which is absent in CI and would otherwise make
 * `config.ts` abort the run with `process.exit(1)`.
 *
 * `dotenv/config` (imported by `config.ts`) does not override variables that
 * are already set, so these values remain authoritative for the suite.
 */
import { applyBaseEnv } from "./base-env.js";

applyBaseEnv();

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/db";
