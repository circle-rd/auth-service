import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { oauthClient } from "../db/auth-schema.js";
import { ERR } from "../errors.js";
import { verifyBearerAccessToken } from "./oauth-tokens.js";

export const MACHINE_SCOPES = ["m2m", "wallet:debit", "wallet:read"] as const;
export type MachineScope = (typeof MACHINE_SCOPES)[number];

/**
 * Authorize a machine-to-machine call: a valid `client_credentials` token
 * carrying `scope`. The client's current configuration is checked as well as
 * the token, so disabling a client or removing a scope takes effect at once
 * instead of when the (possibly stateless JWT) token expires.
 */
export async function requireMachineScope(
  authorization: string | undefined,
  scope: MachineScope,
): Promise<{ clientId: string }> {
  if (!authorization?.startsWith("Bearer ")) throw ERR.AUTH_001();

  const verified = await verifyBearerAccessToken(authorization.slice(7));
  if (!verified) throw ERR.AUTH_001("Invalid or expired access token");
  if (verified.userId) {
    throw ERR.AUTH_011("A client_credentials token is required");
  }
  if (!verified.scopes.includes(scope)) {
    throw ERR.AUTH_011(`Missing required scope: ${scope}`);
  }

  const [client] = await db
    .select({
      disabled: oauthClient.disabled,
      scopes: oauthClient.clientCredentialsScopes,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, verified.clientId))
    .limit(1);
  if (!client || client.disabled || !client.scopes?.includes(scope)) {
    throw ERR.AUTH_011(`Client is not authorized for scope: ${scope}`);
  }
  return { clientId: verified.clientId };
}
