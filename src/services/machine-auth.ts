import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { oauthClient } from "../db/auth-schema.js";
import { applications } from "../db/schema.js";
import { ERR } from "../errors.js";
import type { MachineScope } from "./machine-scopes.js";
import { verifyBearerAccessToken } from "./oauth-tokens.js";

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
  // A JWT minted for another resource server must not be replayed here; an
  // opaque token carries no audience and is bound to its client by its row.
  if (
    verified.audiences.length > 0 &&
    !verified.audiences.includes(config.betterAuth.url)
  ) {
    throw ERR.AUTH_011("Access token audience does not include this API");
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

/**
 * Authorize a machine call made on behalf of one application. The client id of
 * a client_credentials token is the application slug, so the caller can only
 * ever act for its own application: no route accepts an application id from
 * the request.
 */
export async function requireMachineApplication(
  authorization: string | undefined,
  scope: MachineScope,
): Promise<{ applicationId: string; clientId: string }> {
  const { clientId } = await requireMachineScope(authorization, scope);
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.slug, clientId))
    .limit(1);
  if (!app) throw ERR.APP_002();
  return { applicationId: app.id, clientId };
}
