import { verifyJwsAccessToken } from "better-auth/oauth2";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  jwks as jwksTable,
  oauthAccessToken,
  oauthRefreshToken,
  oauthResource,
} from "../db/auth-schema.js";
import { config } from "../config.js";

type JwksFetchOptions = Parameters<typeof verifyJwsAccessToken>[1];
type JwksFetchFn = Exclude<JwksFetchOptions["jwksFetch"], string>;
type Jwks = Awaited<ReturnType<JwksFetchFn>>;

/**
 * Load the verification key set straight from the local `jwks` table instead
 * of fetching our own `/jwks` endpoint over HTTP. Avoids a self network call
 * (which would also be impossible when the app is driven via `inject()`), and
 * mirrors the public JWKs the endpoint would serve — including the `kid`
 * header mapping (key row id) the JWT is signed with.
 */
async function loadLocalJwks(): Promise<Jwks> {
  const rows = await db
    .select({
      id: jwksTable.id,
      publicKey: jwksTable.publicKey,
      alg: jwksTable.alg,
      crv: jwksTable.crv,
      expiresAt: jwksTable.expiresAt,
    })
    .from(jwksTable);
  const now = Date.now();
  // Same default grace period as the jwt plugin (30 days).
  const graceMs = 30 * 24 * 60 * 60 * 1000;
  const keys = rows
    .filter((row) => !row.expiresAt || row.expiresAt.getTime() + graceMs > now)
    .map((row) => ({
      alg: row.alg ?? "EdDSA",
      ...(row.crv ? { crv: row.crv } : {}),
      ...(JSON.parse(row.publicKey) as Record<string, unknown>),
      kid: row.id,
    }));
  return { keys } as Jwks;
}

export interface VerifiedAccessToken {
  /** OAuth client id, which equals the application slug. */
  clientId: string;
  /** User id for user-bound tokens; null for client_credentials (M2M) tokens. */
  userId: string | null;
  scopes: string[];
}

/**
 * The set of audiences a token may legitimately carry: every enabled
 * protected resource plus the issuer itself. Passed to the JWKS verifier so a
 * token minted for one application cannot be replayed against another.
 */
async function acceptedAudiences(): Promise<string[]> {
  const rows = await db
    .select({ identifier: oauthResource.identifier })
    .from(oauthResource)
    .where(eq(oauthResource.disabled, false));
  const all = new Set<string>(rows.map((r) => r.identifier));
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
      const payload = await verifyJwsAccessToken(token, {
        jwksFetch: loadLocalJwks,
        verifyOptions: {
          issuer: config.betterAuth.url,
          audience: await acceptedAudiences(),
        },
      });
      const clientId = typeof payload.azp === "string" ? payload.azp : null;
      if (!clientId) return null;
      const sub = typeof payload.sub === "string" ? payload.sub : null;
      return {
        clientId,
        // For client_credentials tokens BetterAuth sets `sub` to the client id
        // (there is no user) and `azp` to the same client id; a user-bound
        // token has a distinct `sub`.
        userId: sub && sub !== clientId ? sub : null,
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
  await db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
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
