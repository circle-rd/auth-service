import { verifyAccessToken } from "better-auth/oauth2";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { oauthAccessToken, oauthRefreshToken } from "../db/auth-schema.js";
import { config } from "../config.js";
import { validAudiences } from "../runtime-config.js";

export interface VerifiedAccessToken {
  /** OAuth client id, which equals the application slug. */
  clientId: string;
  /** User id for user-bound tokens; null for client_credentials (M2M) tokens. */
  userId: string | null;
  scopes: string[];
}

/**
 * The set of audiences a token may legitimately carry: every registered
 * application URL plus the issuer itself. Passed to the JWKS verifier so a
 * token minted for one application cannot be replayed against another.
 */
function acceptedAudiences(): string[] {
  const all = new Set<string>(validAudiences);
  all.add(config.betterAuth.url);
  return [...all];
}

/**
 * Verify a Bearer access token issued by this service and return its bound
 * client. JWT tokens are checked locally against the JWKS (signature, issuer,
 * audience and expiry); opaque tokens are validated against their database
 * row. Returns null when the token is invalid, expired or not bound to a
 * client, so callers can fail closed.
 */
export async function verifyBearerAccessToken(
  token: string,
): Promise<VerifiedAccessToken | null> {
  if (token.split(".").length === 3) {
    try {
      const payload = await verifyAccessToken(token, {
        verifyOptions: {
          issuer: config.betterAuth.url,
          audience: acceptedAudiences(),
        },
        jwksUrl: `${config.betterAuth.url}/api/auth/jwks`,
      });
      const clientId = typeof payload.azp === "string" ? payload.azp : null;
      if (!clientId) return null;
      return {
        clientId,
        userId: typeof payload.sub === "string" ? payload.sub : null,
        scopes:
          typeof payload.scope === "string" ? payload.scope.split(" ") : [],
      };
    } catch {
      return null;
    }
  }

  const [row] = await db
    .select({
      clientId: oauthAccessToken.clientId,
      userId: oauthAccessToken.userId,
      scopes: oauthAccessToken.scopes,
      expiresAt: oauthAccessToken.expiresAt,
    })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.token, token))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  return {
    clientId: row.clientId,
    userId: row.userId ?? null,
    scopes: row.scopes ?? [],
  };
}

/**
 * Revoke every OAuth token a user holds for a single client. Used when access
 * to an application is revoked so an existing refresh token cannot keep minting
 * access tokens.
 */
export async function revokeUserClientTokens(
  userId: string,
  clientId: string,
): Promise<void> {
  await db
    .update(oauthRefreshToken)
    .set({ revoked: new Date() })
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        eq(oauthRefreshToken.clientId, clientId),
      ),
    );
  await db
    .delete(oauthAccessToken)
    .where(
      and(
        eq(oauthAccessToken.userId, userId),
        eq(oauthAccessToken.clientId, clientId),
      ),
    );
}

/** Revoke every OAuth token a user holds across all clients (ban/delete). */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await db
    .update(oauthRefreshToken)
    .set({ revoked: new Date() })
    .where(eq(oauthRefreshToken.userId, userId));
  await db
    .delete(oauthAccessToken)
    .where(eq(oauthAccessToken.userId, userId));
}

/** Revoke every token issued to a client (secret rotation, app deletion). */
export async function revokeClientTokens(clientId: string): Promise<void> {
  await db
    .update(oauthRefreshToken)
    .set({ revoked: new Date() })
    .where(eq(oauthRefreshToken.clientId, clientId));
  await db
    .delete(oauthAccessToken)
    .where(eq(oauthAccessToken.clientId, clientId));
}
