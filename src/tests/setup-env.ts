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

// Enable email-driven passwordless flows so their /api/auth/* endpoints are
// mounted by BetterAuth. The transport itself is swapped to MailCaptureTransport
// in `helpers/server.ts` so no real SMTP relay is touched.
process.env.MAGIC_LINK_ENABLED = "true";
process.env.EMAIL_OTP_ENABLED = "true";
// Gate session issuance on verified email so the verification flow can be
// exercised end-to-end (sign-up returns no session; user must click the link).
process.env.REQUIRE_EMAIL_VERIFICATION = "true";
