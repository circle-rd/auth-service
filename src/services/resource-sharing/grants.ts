import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applications,
  resourceGrants,
  sharedResources,
  subscriptionPlans,
  userApplications,
} from "../../db/schema.js";
import { ERR } from "../../errors.js";
import type { DbExecutor } from "../credential-user.js";

export type ResourceGrant = typeof resourceGrants.$inferSelect;

export interface ResourceGrantView extends ResourceGrant {
  planName: string;
}

export interface CreateResourceGrantInput {
  subjectId: string;
  ownerApplicationId: string;
  resourceId?: string | null;
  planId: string;
  allowedClientIds?: string[] | null;
  expiresAt?: Date | null;
  createdBy: string;
}

export async function assertApplicationExists(
  applicationId: string,
  exec: DbExecutor = db,
): Promise<void> {
  const [app] = await exec
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!app) throw ERR.APP_002();
}

export async function assertPlanBelongsToOwner(
  planId: string,
  ownerApplicationId: string,
  exec: DbExecutor = db,
): Promise<void> {
  const [plan] = await exec
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.id, planId),
        eq(subscriptionPlans.applicationId, ownerApplicationId),
      ),
    )
    .limit(1);
  if (!plan) {
    throw ERR.RES_001("Plan does not belong to the owner application");
  }
}

export async function assertResourceBelongsToOwner(
  resourceId: string,
  ownerApplicationId: string,
  exec: DbExecutor = db,
): Promise<void> {
  const [resource] = await exec
    .select({ id: sharedResources.id })
    .from(sharedResources)
    .where(
      and(
        eq(sharedResources.id, resourceId),
        eq(sharedResources.ownerApplicationId, ownerApplicationId),
      ),
    )
    .limit(1);
  if (!resource) throw ERR.RES_002();
}

export async function createResourceGrant(
  input: CreateResourceGrantInput,
  exec: DbExecutor = db,
): Promise<ResourceGrant> {
  await assertApplicationExists(input.ownerApplicationId, exec);
  await assertPlanBelongsToOwner(input.planId, input.ownerApplicationId, exec);
  if (input.resourceId) {
    await assertResourceBelongsToOwner(
      input.resourceId,
      input.ownerApplicationId,
      exec,
    );
  }
  if (input.allowedClientIds !== undefined && input.allowedClientIds !== null) {
    if (input.allowedClientIds.length === 0) {
      throw ERR.RES_001("allowedClientIds must not be empty");
    }
  }

  const now = new Date();
  const [existing] = await exec
    .select({ id: resourceGrants.id })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.subjectId, input.subjectId),
        eq(resourceGrants.ownerApplicationId, input.ownerApplicationId),
        input.resourceId
          ? eq(resourceGrants.resourceId, input.resourceId)
          : isNull(resourceGrants.resourceId),
        isNull(resourceGrants.revokedAt),
        or(isNull(resourceGrants.expiresAt), gt(resourceGrants.expiresAt, now)),
      ),
    )
    .limit(1);
  if (existing) throw ERR.RES_008();

  const allowedClientIds = input.allowedClientIds
    ? [...new Set(input.allowedClientIds)]
    : null;
  const [row] = await exec
    .insert(resourceGrants)
    .values({
      subjectId: input.subjectId,
      ownerApplicationId: input.ownerApplicationId,
      resourceId: input.resourceId ?? null,
      planId: input.planId,
      allowedClientIds,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  if (!row) throw ERR.RES_001("Resource grant could not be created");
  return row;
}

export async function revokeResourceGrant(
  id: string,
  revokedAt: Date = new Date(),
): Promise<ResourceGrant> {
  const [current] = await db
    .select({
      id: resourceGrants.id,
      subjectId: resourceGrants.subjectId,
      ownerApplicationId: resourceGrants.ownerApplicationId,
      resourceId: resourceGrants.resourceId,
      planId: resourceGrants.planId,
      allowedClientIds: resourceGrants.allowedClientIds,
      expiresAt: resourceGrants.expiresAt,
      revokedAt: resourceGrants.revokedAt,
      createdBy: resourceGrants.createdBy,
      createdAt: resourceGrants.createdAt,
    })
    .from(resourceGrants)
    .where(eq(resourceGrants.id, id))
    .limit(1);
  if (!current) throw ERR.RES_007();
  if (current.revokedAt) return current;

  const [row] = await db
    .update(resourceGrants)
    .set({ revokedAt })
    .where(eq(resourceGrants.id, id))
    .returning();
  if (!row) throw ERR.RES_007();
  return row;
}

/** A grant scoped to its owner application; foreign and missing ids both 404. */
export async function getGrantForOwner(
  id: string,
  ownerApplicationId: string,
): Promise<ResourceGrant> {
  const [row] = await db
    .select()
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.id, id),
        eq(resourceGrants.ownerApplicationId, ownerApplicationId),
      ),
    )
    .limit(1);
  if (!row) throw ERR.RES_007();
  return row;
}

export async function listGrantsForOwner(
  ownerApplicationId: string,
): Promise<ResourceGrantView[]> {
  return db
    .select({
      id: resourceGrants.id,
      subjectId: resourceGrants.subjectId,
      ownerApplicationId: resourceGrants.ownerApplicationId,
      resourceId: resourceGrants.resourceId,
      planId: resourceGrants.planId,
      allowedClientIds: resourceGrants.allowedClientIds,
      expiresAt: resourceGrants.expiresAt,
      revokedAt: resourceGrants.revokedAt,
      createdBy: resourceGrants.createdBy,
      createdAt: resourceGrants.createdAt,
      planName: subscriptionPlans.name,
    })
    .from(resourceGrants)
    .innerJoin(
      subscriptionPlans,
      eq(resourceGrants.planId, subscriptionPlans.id),
    )
    .where(eq(resourceGrants.ownerApplicationId, ownerApplicationId))
    .orderBy(desc(resourceGrants.createdAt));
}

export interface UpdateResourceGrantInput {
  resourceId?: string | null;
  planId?: string;
  allowedClientIds?: string[] | null;
  expiresAt?: Date | null;
}

export async function updateResourceGrant(
  id: string,
  ownerApplicationId: string,
  patch: UpdateResourceGrantInput,
): Promise<ResourceGrant> {
  const current = await getGrantForOwner(id, ownerApplicationId);
  if (current.revokedAt) {
    throw ERR.RES_001("A revoked grant cannot be updated");
  }
  if (patch.planId !== undefined) {
    await assertPlanBelongsToOwner(patch.planId, ownerApplicationId);
  }
  if (patch.resourceId !== undefined && patch.resourceId !== null) {
    await assertResourceBelongsToOwner(patch.resourceId, ownerApplicationId);
  }
  if (patch.allowedClientIds !== undefined && patch.allowedClientIds !== null) {
    if (patch.allowedClientIds.length === 0) {
      throw ERR.RES_001("allowedClientIds must not be empty");
    }
  }

  const allowedClientIds =
    patch.allowedClientIds === undefined
      ? current.allowedClientIds
      : patch.allowedClientIds === null
        ? null
        : [...new Set(patch.allowedClientIds)];
  const [row] = await db
    .update(resourceGrants)
    .set({
      resourceId:
        patch.resourceId === undefined ? current.resourceId : patch.resourceId,
      planId: patch.planId ?? current.planId,
      allowedClientIds,
      expiresAt:
        patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
    })
    .where(eq(resourceGrants.id, id))
    .returning();
  if (!row) throw ERR.RES_007();
  return row;
}

/** Latest explicit grant for the subject, whether revoked or expired. */
export async function findLatestGrant(
  subjectId: string,
  ownerApplicationId: string,
  resourceId: string,
): Promise<ResourceGrantView | null> {
  const [row] = await db
    .select({
      id: resourceGrants.id,
      subjectId: resourceGrants.subjectId,
      ownerApplicationId: resourceGrants.ownerApplicationId,
      resourceId: resourceGrants.resourceId,
      planId: resourceGrants.planId,
      allowedClientIds: resourceGrants.allowedClientIds,
      expiresAt: resourceGrants.expiresAt,
      revokedAt: resourceGrants.revokedAt,
      createdBy: resourceGrants.createdBy,
      createdAt: resourceGrants.createdAt,
      planName: subscriptionPlans.name,
    })
    .from(resourceGrants)
    .innerJoin(
      subscriptionPlans,
      eq(resourceGrants.planId, subscriptionPlans.id),
    )
    .where(
      and(
        eq(resourceGrants.subjectId, subjectId),
        eq(resourceGrants.ownerApplicationId, ownerApplicationId),
        or(
          eq(resourceGrants.resourceId, resourceId),
          isNull(resourceGrants.resourceId),
        ),
      ),
    )
    .orderBy(desc(resourceGrants.createdAt))
    .limit(1);
  return row ?? null;
}

export async function hasActiveMembership(
  subjectId: string,
  ownerApplicationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: userApplications.id })
    .from(userApplications)
    .where(
      and(
        eq(userApplications.userId, subjectId),
        eq(userApplications.applicationId, ownerApplicationId),
        eq(userApplications.isActive, true),
      ),
    )
    .limit(1);
  return row !== undefined;
}
