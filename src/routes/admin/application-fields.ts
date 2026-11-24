import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { ERR } from "../../errors.js";
import { getRequestSession } from "../../middleware.js";
import { decryptResourceWebhookSecret } from "../../services/resources/webhooks.js";

/**
 * The admin view exposes the webhook secret so an operator can configure the
 * receiver. The stored value is ciphertext; callers never see that form.
 */
export function withResourceWebhookSecret<
  T extends { resourceWebhookSecret: string | null },
>(
  app: T,
): Omit<T, "resourceWebhookSecret"> & {
  resourceWebhookSecret: string | null;
} {
  return {
    ...app,
    resourceWebhookSecret: app.resourceWebhookSecret
      ? decryptResourceWebhookSecret(app.resourceWebhookSecret)
      : null,
  };
}

/**
 * Reserved JWT claim names that MUST NOT be overridden via per-application
 * metadata. These are managed by the OAuth provider itself.
 */
const RESERVED_JWT_CLAIMS = new Set([
  "sub",
  "aud",
  "iss",
  "exp",
  "iat",
  "nbf",
  "jti",
  "scope",
  "scopes",
  "azp",
  "client_id",
  "token_type",
  "auth_time",
  "acr",
  "amr",
]);

/**
 * Zod schema for the `metadata` field on applications. Values are restricted
 * to strings because they are surfaced to resource servers via the JWT
 * `client_attrs` field, whose contract requires string-typed entries (see
 * EMQX 5 JWT authn / client attributes spec). Keep keys to safe identifiers.
 */
export const metadataSchema = z
  .record(z.string(), z.string().max(256))
  .refine((m) => Object.keys(m).every((k) => !RESERVED_JWT_CLAIMS.has(k)), {
    message: "metadata keys must not collide with reserved JWT claims",
  })
  .refine(
    (m) => Object.keys(m).every((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)),
    {
      message:
        "metadata keys must be valid identifiers (letters, digits, underscore)",
    },
  );

// ── Middleware ────────────────────────────────────────────────────────────────

export const allowedResourcesSchema = z
  .array(z.string().url())
  .transform((list) => [...new Set(list)]);

/** Hiding an application and protecting it from deletion is a superadmin decision. */
export async function assertMaySetSystemFlag(
  req: FastifyRequest,
): Promise<void> {
  const session = await getRequestSession(req);
  if (!session) throw ERR.AUTH_001();
  if ((session.user as Record<string, unknown>).role !== "superadmin") {
    throw ERR.AUTH_011("Only superadmins can change the system flag");
  }
}
