import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  gatewayObjects,
  resourceGatewayLinks,
} from "../../db/gateway-schema.js";
import { resourceGrants, resources } from "../../db/resource-schema.js";
import { ERR } from "../../errors.js";
import type { DbExecutor } from "../credential-user.js";
import { assertCanManageResource } from "./authority.js";
import { RELAY_MANAGER } from "./provenance.js";
import { activeGrantSubjects, announceResourceChanged } from "./realtime.js";
import { getResource, type ResourceView } from "./registry.js";
import type { ResourceSubjectType } from "./types.js";
import { enqueueResourceDeletedEvent } from "./webhook-events.js";

/**
 * The mirror declares a resource again for every relay model that is still
 * served, so deleting one would only bring it back: the owner stops serving the
 * model first.
 */
async function isServedByRelay(resourceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: gatewayObjects.id })
    .from(resourceGatewayLinks)
    .innerJoin(
      gatewayObjects,
      eq(resourceGatewayLinks.gatewayObjectId, gatewayObjects.id),
    )
    .where(
      and(
        eq(resourceGatewayLinks.resourceId, resourceId),
        eq(gatewayObjects.isActive, true),
        sql`${gatewayObjects.metadata}->>'managedBy' = ${RELAY_MANAGER}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Delete a resource for good. Its grants, invitations and gateway link go with
 * it; access events and usage keep their rows without the resource id. The
 * owner application and every application it was shared with are told.
 */
export async function deleteResourceRow(
  resource: ResourceView,
  exec: DbExecutor = db,
): Promise<void> {
  const subjects = await activeGrantSubjects(resource.id);
  const run = async (tx: DbExecutor) => {
    await enqueueResourceDeletedEvent(resource, tx);
    await tx.delete(resources).where(eq(resources.id, resource.id));
  };
  if (exec === db) await db.transaction((tx) => run(tx));
  else await run(exec);
  await announceResourceChanged(resource, subjects);
}

export async function removeResource(
  id: string,
  actorUserId: string,
): Promise<ResourceView> {
  const current = await getResource(id);
  await assertCanManageResource(actorUserId, current);
  if (await isServedByRelay(id)) throw ERR.RES_019();
  await deleteResourceRow(current);
  return current;
}

/** Delete every resource a user owns, when their account is deleted. */
export async function deleteResourcesOwnedByUser(
  userId: string,
  exec: DbExecutor = db,
): Promise<void> {
  const owned = await exec
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.ownerType, "user"), eq(resources.ownerId, userId)));
  for (const row of owned) {
    await deleteResourceRow(await getResource(row.id), exec);
  }
}

/** Delete the grants that name a subject which no longer exists. */
export async function deleteGrantsNamingSubject(
  subjectType: Extract<
    ResourceSubjectType,
    "user" | "organization" | "application"
  >,
  subjectId: string,
  exec: DbExecutor = db,
): Promise<number> {
  const deleted = await exec
    .delete(resourceGrants)
    .where(
      and(
        eq(resourceGrants.subjectType, subjectType),
        eq(resourceGrants.subjectId, subjectId),
      ),
    )
    .returning({ id: resourceGrants.id });
  return deleted.length;
}
