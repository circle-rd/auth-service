import { createJwk } from "better-auth/plugins";
import { count, eq, isNull, or } from "drizzle-orm";
import { auth } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { jwks } from "../db/auth-schema.js";
import { logger } from "../logger.js";
import { jwksOptions } from "./key-pair.js";

/**
 * The jwt plugin signs with the newest key of the configured algorithm and,
 * when there is none, falls back to the newest key of any algorithm. After
 * `JWT_PRIMARY_ALG` changes on an instance that already holds keys, tokens
 * would therefore keep the old algorithm until the next monthly rotation. Mint
 * the missing key at startup, and say so: this is meant for a deliberate
 * switch, not something a production instance should hit routinely.
 *
 * An empty table needs nothing: the plugin creates the first key itself.
 */
export async function ensureSigningKey(): Promise<void> {
  const alg = config.compat.signingAlg;

  const [{ total }] = await db.select({ total: count() }).from(jwks);
  if (total === 0) return;

  // A key row without `alg` predates the column and is an EdDSA key.
  const [{ matching }] = await db
    .select({ matching: count() })
    .from(jwks)
    .where(
      alg === "EdDSA"
        ? or(eq(jwks.alg, alg), isNull(jwks.alg))
        : eq(jwks.alg, alg),
    );
  if (matching > 0) return;

  const context = await auth.$context;
  await createJwk({ context } as unknown as Parameters<typeof createJwk>[0], {
    jwks: jwksOptions(alg),
  });
  logger.warn(
    { alg, production: config.nodeEnv === "production" },
    config.nodeEnv === "production"
      ? `[compat] JWT_PRIMARY_ALG=${alg} had no signing key: a new key was created. This should not happen in production; the algorithm is meant to be chosen before the first start. Tokens signed earlier stay valid until their key expires.`
      : `[compat] JWT_PRIMARY_ALG=${alg} had no signing key: a new key was created. Tokens signed earlier stay valid until their key expires.`,
  );
}
