import { and, eq, inArray, ne } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { oauthClient } from "../db/auth-schema.js";
import { applications } from "../db/schema.js";
import { logger } from "../logger.js";

type SecretAuthMethod = "client_secret_basic" | "client_secret_post";

/**
 * Token endpoint authentication of a confidential client. A client registers
 * for exactly one method and the OAuth provider refuses the other, so the
 * instance-wide setting is applied when the client is created and re-applied at
 * startup. System applications keep HTTP Basic: the gateway's own clients are
 * provisioned by scripts that depend on it.
 */
export function clientSecretAuthMethod(isSystem: boolean): SecretAuthMethod {
  return !isSystem && config.compat.tokenAuthMethod === "post"
    ? "client_secret_post"
    : "client_secret_basic";
}

/** Bring existing confidential clients in line with TOKEN_ENDPOINT_AUTH_METHOD. */
export async function reconcileTokenAuthMethod(): Promise<void> {
  const target = clientSecretAuthMethod(false);
  const userApplicationSlugs = db
    .select({ slug: applications.slug })
    .from(applications)
    .where(eq(applications.isSystem, false));

  const updated = await db
    .update(oauthClient)
    .set({ tokenEndpointAuthMethod: target })
    .where(
      and(
        inArray(oauthClient.tokenEndpointAuthMethod, [
          "client_secret_basic",
          "client_secret_post",
        ]),
        ne(oauthClient.tokenEndpointAuthMethod, target),
        inArray(oauthClient.clientId, userApplicationSlugs),
      ),
    )
    .returning({ clientId: oauthClient.clientId });

  if (updated.length > 0) {
    logger.info(
      { method: target, clients: updated.length },
      "[compat] confidential clients moved to the configured token endpoint authentication",
    );
  }
}
