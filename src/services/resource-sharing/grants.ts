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

async function assertApplicationExists(applicationId: string): Promise<void> {
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!app) throw ERR.APP_002();
}

async function assertPlanBelongsToOwner(
  planId: string,
  ownerApplicationId: string,
): Promise<void> {
  const [plan] = await db
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

async function assertResourceBelongsToOwner(
  resourceId: string,
  ownerApplicationId: string,
): Promise<void> {
  const [resource] = await db
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
): Promise<ResourceGrant> {
  await assertApplicationExists(input.ownerApplicationId);
  await assertPlanBelongsToOwner(input.planId, input.ownerApplicationId);
  if (input.resourceId) {
    await assertResourceBelongsToOwner(
      input.resourceId,
      input.ownerApplicationId,
    );
  }
  if (input.allowedClientIds !== undefined && input.allowedClientIds !== null) {
    if (input.allowedClientIds.length === 0) {
      throw ERR.RES_001("allowedClientIds must not be empty");
    }
  }

  const now = new Date();
  const [existing] = await db
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
  const [row] = await db
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
