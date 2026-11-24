import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications, subscriptionPlans } from "../../db/schema.js";
import { organization, user as userTable } from "../../db/auth-schema.js";
import {
  resourceGrants,
  resources as resourcesTable,
} from "../../db/resource-schema.js";
import { ERR } from "../../errors.js";
import type { DbExecutor } from "../credential-user.js";
import { assertCanGrantToSubject, assertCanManageGrants } from "./authority.js";
import { getResource, type ResourceView } from "./registry.js";
import { announceResourceChanged } from "./realtime.js";
import { assertPermissionSupported } from "./schemes.js";
import { isSchemeEnabledForApplication } from "./scheme-service.js";
import type { ResourcePermission, ResourceSubjectType } from "./types.js";
import { enqueueResourceWebhookEvent } from "./webhook-events.js";

export type ResourceGrantRow = typeof resourceGrants.$inferSelect;

export interface CreateResourceGrantInput {
  resourceId: string;
  subjectType: ResourceSubjectType;
  subjectId: string | null;
  actorUserId: string;
  permission?: ResourcePermission;
  expiresAt?: Date | null;
}

export interface InsertResourceGrantInput {
  resourceId: string;
  subjectType: ResourceSubjectType;
  subjectId: string | null;
  createdBy: string;
  permission?: ResourcePermission;
  expiresAt?: Date | null;
}

/**
 * Low-level insertion used by the invitation redemption path. Callers that act
 * on behalf of a user must use `createResourceGrant` so the authority matrix is
 * applied first.
 */
export async function insertResourceGrant(
  input: InsertResourceGrantInput,
  exec: DbExecutor = db,
): Promise<ResourceGrantRow> {
  // Resolve the resource and subject before opening a transaction so the
  // connection is not held while these global-pool reads run.
  const resource = await getResource(input.resourceId);
  assertPermissionSupported(resource.scheme, input.permission ?? "read");
  await assertSubjectExists(resource, input.subjectType, input.subjectId);
  if (exec === db) {
    return db.transaction((tx) => insertResourceGrantRow(input, resource, tx));
  }
  return insertResourceGrantRow(input, resource, exec);
}

async function insertResourceGrantRow(
  input: InsertResourceGrantInput,
  resource: ResourceView,
  exec: DbExecutor,
): Promise<ResourceGrantRow> {
  // Serialize concurrent inserts for this resource so the duplicate check and
  // the insert cannot interleave into two active grants.
  await exec
    .select({ id: resourcesTable.id })
    .from(resourcesTable)
    .where(eq(resourcesTable.id, input.resourceId))
    .for("update");

  const now = new Date();
  const [existing] = await exec
    .select({ id: resourceGrants.id })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceId, input.resourceId),
        eq(resourceGrants.subjectType, input.subjectType),
        input.subjectId
          ? eq(resourceGrants.subjectId, input.subjectId)
          : isNull(resourceGrants.subjectId),
        isNull(resourceGrants.revokedAt),
        or(isNull(resourceGrants.expiresAt), gt(resourceGrants.expiresAt, now)),
      ),
    )
    .limit(1);
  if (existing) throw ERR.RES_008();

  const [row] = await exec
    .insert(resourceGrants)
    .values({
      resourceId: input.resourceId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      permission: input.permission ?? "read",
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  if (!row) throw ERR.RES_001("Resource grant could not be created");
  await enqueueResourceWebhookEvent(
    {
      type: "resource.grant.created",
      resource,
      grant: {
        id: row.id,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        permission: row.permission,
        expiresAt: row.expiresAt,
      },
    },
    exec,
  );
  return row;
}

export async function createResourceGrant(
  input: CreateResourceGrantInput,
  exec: DbExecutor = db,
): Promise<ResourceGrantRow> {
  const resource = await getResource(input.resourceId);
  await assertCanGrantToSubject(
    input.actorUserId,
    resource,
    input.subjectType,
    input.subjectId,
  );
  const grant = await insertResourceGrant(
    {
      resourceId: input.resourceId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      createdBy: input.actorUserId,
      permission: input.permission,
      expiresAt: input.expiresAt,
    },
    exec,
  );
  await announceResourceChanged(resource, [
    { subjectType: grant.subjectType, subjectId: grant.subjectId },
  ]);
  return grant;
}

async function assertSubjectExists(
  resource: ResourceView,
  subjectType: ResourceSubjectType,
  subjectId: string | null,
): Promise<void> {
  if (subjectType === "everyone") {
    if (subjectId !== null) throw ERR.RES_001("everyone has no subject id");
    return;
  }
  if (!subjectId) throw ERR.RES_001("A subject id is required");
  if (subjectType === "user") {
    const [row] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.id, subjectId))
      .limit(1);
    if (!row) throw ERR.USR_001();
    return;
  }
  if (subjectType === "application") {
    const [app] = await db
      .select({
        id: applications.id,
        active: applications.isActive,
        sharing: applications.resourceSharingEnabled,
      })
      .from(applications)
      .where(eq(applications.slug, subjectId))
      .limit(1);
    if (!app?.active || !app.sharing) {
      throw ERR.RES_001("The application is not available for sharing");
    }
    if (app.id === resource.applicationId) {
      throw ERR.RES_001("The owner application already has access");
    }
    if (!(await isSchemeEnabledForApplication(app.id, resource.scheme))) {
      throw ERR.RES_001("The scheme is not enabled for that application");
    }
    return;
  }
  if (subjectType === "organization") {
    const [row] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, subjectId))
      .limit(1);
    if (!row) throw ERR.ORG_001();
    return;
  }
  const [plan] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.id, subjectId),
        eq(subscriptionPlans.applicationId, resource.applicationId),
      ),
    )
    .limit(1);
  if (!plan) throw ERR.RES_001("Plan does not belong to this application");
}

export async function getGrantForResource(
  id: string,
  resourceId: string,
): Promise<ResourceGrantRow> {
  const [row] = await db
    .select()
    .from(resourceGrants)
    .where(
      and(eq(resourceGrants.id, id), eq(resourceGrants.resourceId, resourceId)),
    )
    .limit(1);
  if (!row) throw ERR.RES_007();
  return row;
}

export async function revokeResourceGrant(
  id: string,
  actorUserId: string,
): Promise<ResourceGrantRow> {
  const [current] = await db
    .select()
    .from(resourceGrants)
    .where(eq(resourceGrants.id, id))
    .limit(1);
  if (!current) throw ERR.RES_007();
  const resource = await getResource(current.resourceId);
  await assertCanManageGrants(actorUserId, resource);
  if (current.revokedAt) return current;
  const [row] = await db
    .update(resourceGrants)
    .set({ revokedAt: new Date() })
    .where(eq(resourceGrants.id, id))
    .returning();
  if (!row) throw ERR.RES_007();
  await enqueueResourceWebhookEvent({
    type: "resource.grant.revoked",
    resource,
    grant: {
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      permission: row.permission,
      expiresAt: row.expiresAt,
    },
  });
  await announceResourceChanged(resource, [
    { subjectType: row.subjectType, subjectId: row.subjectId },
  ]);
  return row;
}

function isActiveGrant(grant: ResourceGrantRow, now: Date): boolean {
  return (
    grant.revokedAt === null &&
    (grant.expiresAt === null || grant.expiresAt.getTime() > now.getTime())
  );
}

/** Delete a grant that is already revoked or expired. Revoking stays the way to end access. */
export async function deleteResourceGrant(
  id: string,
  actorUserId: string,
): Promise<void> {
  const [current] = await db
    .select()
    .from(resourceGrants)
    .where(eq(resourceGrants.id, id))
    .limit(1);
  if (!current) throw ERR.RES_007();
  await assertCanManageGrants(
    actorUserId,
    await getResource(current.resourceId),
  );
  if (isActiveGrant(current, new Date())) throw ERR.RES_020();
  await db.delete(resourceGrants).where(eq(resourceGrants.id, id));
}

/** Change the level of an active grant in place: the id, audit fields and expiry stay. */
export async function updateResourceGrantPermission(
  id: string,
  permission: ResourcePermission,
  actorUserId: string,
): Promise<ResourceGrantRow> {
  const [current] = await db
    .select()
    .from(resourceGrants)
    .where(eq(resourceGrants.id, id))
    .limit(1);
  if (!current) throw ERR.RES_007();
  const resource = await getResource(current.resourceId);
  await assertCanManageGrants(actorUserId, resource);
  assertPermissionSupported(resource.scheme, permission);
  const now = new Date();
  if (
    current.revokedAt ||
    (current.expiresAt && current.expiresAt.getTime() <= now.getTime())
  ) {
    throw ERR.RES_015();
  }
  if (current.permission === permission) return current;
  const [row] = await db
    .update(resourceGrants)
    .set({ permission })
    .where(
      and(
        eq(resourceGrants.id, id),
        isNull(resourceGrants.revokedAt),
        or(isNull(resourceGrants.expiresAt), gt(resourceGrants.expiresAt, now)),
      ),
    )
    .returning();
  if (!row) throw ERR.RES_015();
  await enqueueResourceWebhookEvent({
    type: "resource.grant.updated",
    resource,
    grant: {
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      permission: row.permission,
      previousPermission: current.permission,
      expiresAt: row.expiresAt,
    },
  });
  await announceResourceChanged(resource, [
    { subjectType: row.subjectType, subjectId: row.subjectId },
  ]);
  return row;
}
