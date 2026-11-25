import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { user as userTable } from "../../db/auth-schema.js";
import { gatewayObjects } from "../../db/gateway-schema.js";
import { resources } from "../../db/resource-schema.js";
import { applications, userApplications } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { CATALOGUE_SLUG } from "./catalogue-app.js";
import { validateRelayDeclaration } from "./gateway-declaration.js";
import { createResourceGrant } from "./grants.js";
import { RELAY_MANAGER } from "./provenance.js";
import { createResource } from "./registry.js";
import {
  USER_NAMESPACE_PREFIX,
  buildResourceUri,
  userNamespace,
} from "./uri.js";

interface RelayModel {
  objectName: string;
  username: string;
}

/**
 * Active relay models that sit in a user namespace. The relay names each one
 * `u-<username>/<model>` from the identity it verified on the tunnel, and the
 * provenance check repeats that rule before anything is validated.
 */
async function listRelayModels(): Promise<RelayModel[]> {
  const rows = await db
    .select({
      objectName: gatewayObjects.objectName,
      metadata: gatewayObjects.metadata,
    })
    .from(gatewayObjects)
    .where(
      and(
        eq(gatewayObjects.kind, "model"),
        eq(gatewayObjects.isActive, true),
        sql`${gatewayObjects.metadata}->>'managedBy' = ${RELAY_MANAGER}`,
      ),
    );
  const models: RelayModel[] = [];
  for (const row of rows) {
    const clientId = row.metadata.clientId;
    if (typeof clientId !== "string") continue;
    if (!clientId.startsWith(USER_NAMESPACE_PREFIX)) continue;
    const username = clientId.slice(USER_NAMESPACE_PREFIX.length);
    if (!row.objectName.startsWith(`${userNamespace(username)}/`)) continue;
    models.push({ objectName: row.objectName, username });
  }
  return models;
}

async function ownersByUsername(
  usernames: readonly string[],
): Promise<Map<string, string>> {
  if (usernames.length === 0) return new Map();
  const rows = await db
    .select({ id: userTable.id, username: userTable.username })
    .from(userTable)
    .where(
      inArray(
        sql`lower(${userTable.username})`,
        usernames.map((name) => name.toLowerCase()),
      ),
    );
  return new Map(
    rows.flatMap((row) =>
      row.username ? [[row.username.toLowerCase(), row.id] as const] : [],
    ),
  );
}

/** Applications that take every newly declared relay model, read-only. */
async function listAutoShareSlugs(): Promise<string[]> {
  const rows = await db
    .select({ slug: applications.slug })
    .from(applications)
    .where(
      and(
        eq(applications.autoShareRelayModels, true),
        eq(applications.resourceSharingEnabled, true),
        eq(applications.isActive, true),
      ),
    );
  return rows.map((row) => row.slug);
}

/**
 * Declare, in the catalogue application, a resource for each relay model whose
 * owner has a username, and validate it on the relay's provenance. Nothing is
 * declared for a model nobody owns, and an existing resource is left alone: it
 * was declared (or deleted) on purpose. A new resource is shared read-only with
 * the applications that opted in; the owner can revoke that grant. Returns the
 * number of resources made.
 */
export async function declareRelayResources(): Promise<number> {
  const models = await listRelayModels();
  if (models.length === 0) return 0;
  const [catalogue] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.slug, CATALOGUE_SLUG))
    .limit(1);
  if (!catalogue) {
    logger.warn(
      "[res] catalogue application missing; relay models not declared",
    );
    return 0;
  }
  const owners = await ownersByUsername(models.map((m) => m.username));
  const uris = models.map((m) => buildUriOrNull(m.objectName));
  const valid = uris.filter((uri): uri is string => uri !== null);
  if (valid.length === 0) return 0;
  const known = new Set(
    (
      await db
        .select({ uri: resources.uri })
        .from(resources)
        .where(inArray(resources.uri, valid))
    ).map((row) => row.uri),
  );

  let declared = 0;
  const autoShare = await listAutoShareSlugs();
  for (const [index, model] of models.entries()) {
    const uri = uris[index];
    const ownerId = owners.get(model.username.toLowerCase());
    if (!uri || !ownerId || known.has(uri)) continue;
    try {
      await db
        .insert(userApplications)
        .values({
          userId: ownerId,
          applicationId: catalogue.id,
          isActive: true,
        })
        .onConflictDoNothing();
      const resource = await createResource({
        applicationId: catalogue.id,
        scheme: "llm",
        locator: model.objectName,
        displayName: model.objectName,
        ownerType: "user",
        ownerId,
      });
      await validateRelayDeclaration(resource, model.username);
      declared += 1;
      await shareWithApplications(
        resource.id,
        ownerId,
        model.objectName,
        autoShare,
      );
    } catch (err) {
      logger.warn(
        { err, model: model.objectName },
        "[res] relay model could not be declared",
      );
    }
  }
  return declared;
}

/** A refused grant (scheme not enabled, application unavailable) is logged and skipped. */
async function shareWithApplications(
  resourceId: string,
  ownerId: string,
  objectName: string,
  slugs: readonly string[],
): Promise<void> {
  for (const slug of slugs) {
    try {
      await createResourceGrant({
        resourceId,
        subjectType: "application",
        subjectId: slug,
        actorUserId: ownerId,
        permission: "read",
      });
    } catch (err) {
      logger.warn(
        { err, model: objectName, application: slug },
        "[res] relay model could not be shared with application",
      );
    }
  }
}

function buildUriOrNull(objectName: string): string | null {
  try {
    return buildResourceUri("llm", objectName);
  } catch {
    // A name the engine accepts may still not be a valid locator (for example `+`).
    return null;
  }
}
