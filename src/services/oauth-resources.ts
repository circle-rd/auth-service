import { generateId } from "better-auth";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { oauthClientResource, oauthResource } from "../db/auth-schema.js";

/**
 * Keep the BetterAuth 1.7 protected-resource tables in sync with an
 * application. Each application URL is its RFC 8707 resource identifier, so
 * a client may only request an access token whose audience is its own app.
 *
 * `replaceClientResource` is idempotent and safe to call on every create /
 * update: it drops the client's previous links, upserts the resource row by
 * identifier, then re-links the client.
 */
export async function replaceClientResource(opts: {
  clientId: string;
  identifier: string | null;
  name: string;
}): Promise<void> {
  const { clientId, identifier } = opts;

  await db
    .delete(oauthClientResource)
    .where(eq(oauthClientResource.clientId, clientId));

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

/** Remove every resource link owned by a client (application deletion). */
export async function deleteClientResource(clientId: string): Promise<void> {
  await db
    .delete(oauthClientResource)
    .where(eq(oauthClientResource.clientId, clientId));
}
