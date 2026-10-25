import { and, eq, isNotNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";

export interface AudienceRequest {
  path: string;
  method?: string | undefined;
  query?: unknown;
  body?: unknown;
  headers?: Headers | undefined;
}

export interface AudiencePatch {
  context: { query?: { resource: string }; body?: { resource: string } };
}

type Params = Record<string, unknown>;
type UrlLookup = (slug: string) => Promise<string | null>;

const isRecord = (value: unknown): value is Params =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** `url` of the active application whose slug is the OAuth client id. */
export async function applicationUrlBySlug(
  slug: string,
): Promise<string | null> {
  const [row] = await db
    .select({ url: applications.url })
    .from(applications)
    .where(
      and(
        eq(applications.slug, slug),
        eq(applications.isActive, true),
        isNotNull(applications.url),
      ),
    )
    .limit(1);
  return row?.url ?? null;
}

/** Client id of a token request: the Basic credentials, else the body. */
function tokenClientId(headers: Headers | undefined, body: Params) {
  const authorization = headers?.get("authorization");
  if (authorization?.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(
      authorization.slice(6).trim(),
      "base64",
    ).toString("utf8");
    const id = decoded.split(":")[0] ?? "";
    try {
      return decodeURIComponent(id) || null;
    } catch {
      return null;
    }
  }
  return nonEmpty(body.client_id);
}

/**
 * Make the audience of a request behave like the identity provider the
 * instance replaces. Both settings only ever add a `resource`; they never
 * remove or override one the client sent, and the resource is still checked
 * against the client's allowed resources by the OAuth provider.
 *
 * - `AUDIENCE_PARAM`: Auth0 clients send `audience`; it becomes `resource`.
 * - `DEFAULT_AUDIENCE`: Okta issues a JWT for its authorization server without
 *   any parameter; a request with no resource gets the client's own
 *   application URL. Only the requests that start a grant need it, because the
 *   code exchange and the refresh inherit the resources already authorised.
 */
export async function resolveAudiencePatch(
  req: AudienceRequest,
  lookup: UrlLookup = applicationUrlBySlug,
): Promise<AudiencePatch | undefined> {
  const { defaultAudience, audienceParam } = config.compat;
  if (!defaultAudience && !audienceParam) return undefined;

  const body = isRecord(req.body) ? req.body : {};
  const query = isRecord(req.query) ? req.query : {};

  let params: Params;
  let target: "query" | "body";
  let startsGrant: boolean;
  let clientId: string | null;

  if (req.path === "/oauth2/authorize") {
    target = req.method === "POST" ? "body" : "query";
    params = target === "body" ? body : query;
    startsGrant = true;
    clientId = nonEmpty(params.client_id);
  } else if (req.path === "/oauth2/token") {
    target = "body";
    params = body;
    startsGrant = body.grant_type === "client_credentials";
    clientId = tokenClientId(req.headers, body);
  } else {
    return undefined;
  }

  if (params.resource !== undefined && params.resource !== "") {
    return undefined;
  }

  const patch = (resource: string): AudiencePatch =>
    target === "body"
      ? { context: { body: { resource } } }
      : { context: { query: { resource } } };

  if (audienceParam) {
    const audience = nonEmpty(params.audience);
    if (audience) return patch(audience);
  }
  if (defaultAudience && startsGrant && clientId) {
    const url = await lookup(clientId);
    if (url) return patch(url);
  }
  return undefined;
}
