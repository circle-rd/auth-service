import type { AliasSet } from "./profiles.js";

const OIDC = "/api/auth/oauth2";

// Exact paths only: no prefixes, no parameters. Every target is an OAuth or
// OIDC endpoint of this service, never an admin route.
const ALIASES: Record<AliasSet, Record<string, string>> = {
  // Okta: the default authorization server and the org authorization server.
  okta: Object.fromEntries(
    ["/oauth2/default/v1", "/oauth2/v1"].flatMap((base) => [
      [`${base}/authorize`, `${OIDC}/authorize`],
      [`${base}/token`, `${OIDC}/token`],
      [`${base}/keys`, "/api/auth/jwks"],
      [`${base}/userinfo`, `${OIDC}/userinfo`],
      [`${base}/introspect`, `${OIDC}/introspect`],
      [`${base}/revoke`, `${OIDC}/revoke`],
      [`${base}/logout`, `${OIDC}/end-session`],
    ]),
  ),
  // Auth0: SDKs derive these from the tenant domain without reading discovery.
  auth0: {
    "/authorize": `${OIDC}/authorize`,
    "/oauth/token": `${OIDC}/token`,
    "/oauth/revoke": `${OIDC}/revoke`,
    "/userinfo": `${OIDC}/userinfo`,
    "/.well-known/jwks.json": "/api/auth/jwks",
  },
};

export type AliasTable = ReadonlyMap<string, string>;

export function buildAliasTable(sets: readonly AliasSet[]): AliasTable {
  return new Map(sets.flatMap((set) => Object.entries(ALIASES[set])));
}

/**
 * Canonical URL for a request to an alias, or undefined. Fastify calls this
 * before routing and before every hook, so the rate limits, CORS checks and
 * exemptions only ever see the canonical path and need no alias awareness.
 * The query string is carried over untouched.
 */
export function resolveAlias(
  url: string | undefined,
  table: AliasTable,
): string | undefined {
  if (!url || table.size === 0) return undefined;
  const queryStart = url.indexOf("?");
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const target = table.get(path);
  if (!target) return undefined;
  return queryStart === -1 ? target : target + url.slice(queryStart);
}
