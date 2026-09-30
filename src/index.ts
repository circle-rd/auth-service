/**
 * Production entry point.
 *
 * Sequence: migrations (prod) → bootstrap seeding → mail transport verify
 * → runtime-config seeding → buildServer() → listen.
 *
 * The Fastify application factory lives in `server.ts` so integration tests
 * can drive the app via `app.inject()` without binding a port.
 */
import { config } from "./config.js";
import { bootstrap } from "./bootstrap.js";
import { runMigrations } from "./migrate.js";
import { addAudience, addCorsOrigin } from "./runtime-config.js";
import { getMailTransport } from "./services/mail/index.js";
import { db } from "./db/index.js";
import { applications } from "./db/schema.js";
import { isNotNull } from "drizzle-orm";
import { buildServer } from "./server.js";

async function start(): Promise<void> {
  // Run migrations automatically in production; in dev use `pnpm db:push`
  // or `pnpm db:migrate` manually so schema changes are reviewed first.
  if (!config.isDev) {
    await runMigrations();
  }
  await bootstrap();

  const fastify = await buildServer();

  // ── Verify outbound mail transport ────────────────────────────────────
  // In production a failed SMTP check is fatal: every email-dependent flow
  // (verification, reset, magic link, OTP, org invites) would silently
  // break otherwise. In dev/test we log a warning and continue.
  const transport = getMailTransport();
  if (transport.verify) {
    try {
      await transport.verify();
      fastify.log.info(`mail transport=${transport.name} verified`);
    } catch (err) {
      if (config.isDev || config.nodeEnv === "test") {
        fastify.log.warn(
          { err: String(err) },
          `mail transport=${transport.name} verification failed (non-fatal in ${config.nodeEnv})`,
        );
      } else {
        fastify.log.error(
          { err: String(err) },
          `mail transport=${transport.name} verification failed`,
        );
        process.exit(1);
      }
    }
  }

  // ── Seed runtime-config from env vars (static seed) ─────────────────────
  for (const o of config.cors.origins) addCorsOrigin(o);
  for (const aud of config.oauthProvider.validAudiences) addAudience(aud);

  // ── Seed runtime-config from DB — all app URLs ──────────────────────────
  const appRows = await db
    .select({ url: applications.url })
    .from(applications)
    .where(isNotNull(applications.url));
  for (const { url } of appRows) {
    addAudience(url);
    addCorsOrigin(url);
  }

  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(`auth-service listening on ${config.host}:${config.port}`);
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
