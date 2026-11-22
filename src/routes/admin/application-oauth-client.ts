import { db } from "../../db/index.js";
import { oauthClient } from "../../db/auth-schema.js";
import { eq, inArray } from "drizzle-orm";
import { ERR } from "../../errors.js";
import { clientSecretAuthMethod } from "../../compat/token-auth.js";
import { createHash } from "node:crypto";

export /** Hash a plaintext client secret using SHA-256 base64url (matches BetterAuth's defaultHasher). */
function hashClientSecret(secret: string): string {
  return createHash("sha256").update(secret).digest().toString("base64url");
}

/**
 * `enableEndSession`, `postLogoutRedirectUris` and the back-channel logout
 * settings live on the BetterAuth `oauth_client` table, not on `applications`.
 * The admin UI needs them in every payload that exposes an application, so we
 * fetch them by `clientId` (= application slug) and merge them into the
 * response.
 */
interface OauthClientView {
  enableEndSession: boolean;
  postLogoutRedirectUris: string[];
  /** OIDC Back-Channel Logout endpoint, or null when the app does not support it. */
  backchannelLogoutUri: string | null;
  backchannelLogoutSessionRequired: boolean;
  /** Whether the authorization-code flow requires a PKCE code verifier. */
  requirePKCE: boolean;
  /** How the client authenticates to the token endpoint (`none` for public clients). */
  tokenEndpointAuthMethod: string | null;
  /** True when the method was chosen explicitly instead of inherited from config. */
  tokenEndpointAuthMethodExplicit?: boolean;
}

/**
 * The single source of truth for the logout-related column selection, so the
 * read path and the write path cannot drift. Reused by every select below.
 */
const oauthClientViewFields = {
  enableEndSession: oauthClient.enableEndSession,
  postLogoutRedirectUris: oauthClient.postLogoutRedirectUris,
  backchannelLogoutUri: oauthClient.backchannelLogoutUri,
  backchannelLogoutSessionRequired:
    oauthClient.backchannelLogoutSessionRequired,
  requirePKCE: oauthClient.requirePKCE,
  tokenEndpointAuthMethod: oauthClient.tokenEndpointAuthMethod,
  metadata: oauthClient.metadata,
} as const;

export /**
 * Normalise a possibly-missing row into the shape the API promises. The
 * defaults live here once: a historical row may have `enable_end_session =
 * NULL`, and absence is treated as "feature off" rather than silently exposed.
 */
function toOauthClientView(
  row:
    | {
        enableEndSession: boolean | null;
        postLogoutRedirectUris: string[] | null;
        backchannelLogoutUri: string | null;
        backchannelLogoutSessionRequired: boolean | null;
        requirePKCE: boolean | null;
        tokenEndpointAuthMethod: string | null;
        metadata: unknown;
      }
    | undefined,
): OauthClientView {
  return {
    enableEndSession: row?.enableEndSession ?? false,
    postLogoutRedirectUris: row?.postLogoutRedirectUris ?? [],
    backchannelLogoutUri: row?.backchannelLogoutUri ?? null,
    backchannelLogoutSessionRequired:
      row?.backchannelLogoutSessionRequired ?? false,
    requirePKCE: row?.requirePKCE ?? true,
    tokenEndpointAuthMethod: row?.tokenEndpointAuthMethod ?? null,
    tokenEndpointAuthMethodExplicit:
      typeof row?.metadata === "object" &&
      row?.metadata !== null &&
      (row.metadata as Record<string, unknown>)
        .tokenEndpointAuthMethodExplicit === "true",
  };
}

export async function fetchOauthClientView(
  slug: string,
): Promise<OauthClientView> {
  const [row] = await db
    .select(oauthClientViewFields)
    .from(oauthClient)
    .where(eq(oauthClient.clientId, slug))
    .limit(1);
  return toOauthClientView(row);
}

export async function fetchOauthClientViews(
  slugs: string[],
): Promise<Map<string, OauthClientView>> {
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({ clientId: oauthClient.clientId, ...oauthClientViewFields })
    .from(oauthClient)
    .where(inArray(oauthClient.clientId, slugs));
  return new Map(rows.map((r) => [r.clientId, toOauthClientView(r)]));
}

export /**
 * Columns an application create/update writes to the `oauth_client` row for the
 * back-channel logout feature. Defined once so the insert and the response
 * cannot disagree on the null/false sentinels.
 */
function backchannelLogoutValues(data: {
  backchannelLogoutUri?: string | null;
  backchannelLogoutSessionRequired?: boolean;
}) {
  return {
    backchannelLogoutUri: data.backchannelLogoutUri ?? null,
    backchannelLogoutSessionRequired:
      data.backchannelLogoutSessionRequired ?? false,
  };
}

export function mergeOauthView<T extends { slug: string }>(
  app: T,
  view: OauthClientView,
): T & OauthClientView {
  return { ...app, ...view };
}

export /**
 * Compute the effective `postLogoutRedirectUris` whitelist at create time.
 * If the operator did not provide any but supplied a `url`, seed it with the
 * canonical root URL (`${url}/`). This matches the most common SPA pattern
 * (BFF redirects the browser back to the app root after logout) and avoids a
 * silent post-logout failure where AuthService destroys the SSO session but
 * fails to redirect because no entry matches.
 */
function effectivePostLogoutRedirectUris(
  postLogoutRedirectUris: string[],
  url: string | null | undefined,
): string[] {
  if (postLogoutRedirectUris.length > 0) return postLogoutRedirectUris;
  if (!url) return [];
  const root = url.replace(/\/?$/, "/");
  return [root];
}

type ConfidentialTokenAuthMethod = "client_secret_basic" | "client_secret_post";

export /**
 * Reject combinations that would weaken a public client or change the
 * authentication contract of a script-provisioned system client.
 */
function assertOauthClientSettings(input: {
  isPublic: boolean;
  isSystem: boolean;
  requirePKCE?: boolean;
  tokenEndpointAuthMethod?: ConfidentialTokenAuthMethod;
}): void {
  if (input.isPublic && input.requirePKCE === false) {
    throw ERR.APP_001("Public clients must use PKCE");
  }
  if (input.isPublic && input.tokenEndpointAuthMethod !== undefined) {
    throw ERR.APP_001(
      "Public clients do not use a token endpoint authentication method",
    );
  }
  if (
    input.isSystem &&
    input.tokenEndpointAuthMethod !== undefined &&
    input.tokenEndpointAuthMethod !== "client_secret_basic"
  ) {
    throw ERR.APP_001("System clients must use client_secret_basic");
  }
}

export function effectiveTokenEndpointAuthMethod(input: {
  isPublic: boolean;
  isSystem: boolean;
  tokenEndpointAuthMethod?: ConfidentialTokenAuthMethod;
}): string {
  if (input.isPublic) return "none";
  if (input.isSystem) return "client_secret_basic";
  return input.tokenEndpointAuthMethod ?? clientSecretAuthMethod(false);
}

export function effectiveRequirePKCE(input: {
  isPublic: boolean;
  requirePKCE: boolean;
}): boolean {
  return input.isPublic ? true : input.requirePKCE;
}

// ── Routes ────────────────────────────────────────────────────────────────────
