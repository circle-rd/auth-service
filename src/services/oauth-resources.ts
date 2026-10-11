import { generateId } from "better-auth";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { oauthClientResource, oauthResource } from "../db/auth-schema.js";
import { ERR } from "../errors.js";

/**
 * Keep the BetterAuth 1.7 protected-resource tables in sync with an
 * application. Each application URL is its RFC 8707 resource identifier, so
 * a client may only request an access token whose audience is its own app.
 *
 * `replaceClientResource` is idempotent and safe to call on every create /
 * update: it drops the client's previous links, upserts the resource row by
 * identifier, then re-links the client to its own resource plus every
 * resource listed in the application's `allowedResources`.
 */
export async function replaceClientResource(opts: {
  clientId: string;
  identifier: string | null;
  name: string;
  allowedResources: string[];
}): Promise<void> {
  const { clientId, identifier, allowedResources } = opts;

  await db
    .delete(oauthClientResource)
    .where(eq(oauthClientResource.clientId, clientId));

  if (allowedResources.length > 0) {
    await db
      .insert(oauthClientResource)
      .values(
        allowedResources.map((resourceId) => ({
          id: generateId(),
          clientId,
          resourceId,
        })),
      )
      .onConflictDoNothing();
  }

  if (!identifier) return;

  // `allowedScopes` is intentionally left null: it would otherwise be
  // intersected with the requested scopes and reject M2M (`m2m`) scopes, which
  // are not part of the application's OIDC scope allowlist.
  await db
    .insert(oauthResource)
    .values({
      id: generateId(),
      identifier,
      name: opts.name,
    })
    .onConflictDoUpdate({
      target: oauthResource.identifier,
      set: {
        name: opts.name,
        updatedAt: new Date(),
      },
    });

  await db
    .insert(oauthClientResource)
    .values({ id: generateId(), clientId, resourceId: identifier })
    .onConflictDoNothing();
}

/**
 * Reject an `allowedResources` list that cannot be linked: an entry must be an
 * already registered resource (another application's URL) and must not be the
 * application's own URL, which is always linked implicitly.
 */
export async function assertAllowedResources(
  allowedResources: string[],
  ownUrl: string | null,
): Promise<void> {
  if (allowedResources.length === 0) return;
  if (ownUrl !== null && allowedResources.includes(ownUrl)) {
    throw ERR.APP_001("allowedResources must not contain the application URL");
  }
  const known = await db
    .select({ identifier: oauthResource.identifier })
    .from(oauthResource)
    .where(inArray(oauthResource.identifier, allowedResources));
  const knownIds = new Set(known.map((r) => r.identifier));
  const unknown = allowedResources.filter((r) => !knownIds.has(r));
  if (unknown.length > 0) {
    throw ERR.APP_001("Unknown protected resource in allowedResources", {
      unknown,
    });
  }
}

/** Remove every resource link owned by a client (application deletion). */
export async function deleteClientResource(clientId: string): Promise<void> {
  await db
    .delete(oauthClientResource)
    .where(eq(oauthClientResource.clientId, clientId));
}
