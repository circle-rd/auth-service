import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { subscriptionPlans, userSubscriptions } from "../../db/schema.js";
import {
  member,
  organization,
  user as userTable,
} from "../../db/auth-schema.js";
import {
  resourceGrants,
  resources as resourcesTable,
} from "../../db/resource-schema.js";
import { ERR } from "../../errors.js";
import type { DbExecutor } from "../credential-user.js";
import { assertCanGrantToSubject, assertCanManageGrants } from "./authority.js";
import { getResource, type ResourceView } from "./registry.js";
import type { ResourceSubjectType } from "./types.js";

export type ResourceGrantRow = typeof resourceGrants.$inferSelect;

export interface CreateResourceGrantInput {
  resourceId: string;
  subjectType: ResourceSubjectType;
  subjectId: string | null;
  actorUserId: string;
  expiresAt?: Date | null;
}

export interface InsertResourceGrantInput {
  resourceId: string;
  subjectType: ResourceSubjectType;
  subjectId: string | null;
  createdBy: string;
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
  if (exec === db) {
    return db.transaction((tx) => insertResourceGrant(input, tx));
  }
  const resource = await getResource(input.resourceId);
  await assertSubjectExists(resource, input.subjectType, input.subjectId);

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
      permission: "use",
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  if (!row) throw ERR.RES_001("Resource grant could not be created");
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
  return insertResourceGrant(
    {
      resourceId: input.resourceId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      createdBy: input.actorUserId,
      expiresAt: input.expiresAt,
    },
    exec,
  );
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
  return row;
}

export async function listGrantsForResource(
  resourceId: string,
): Promise<ResourceGrantRow[]> {
  return db
    .select()
    .from(resourceGrants)
    .where(eq(resourceGrants.resourceId, resourceId))
    .orderBy(desc(resourceGrants.createdAt));
}

export interface ResourceGrantView extends ResourceGrantRow {
  resourceUri: string;
  resourceDisplayName: string;
  applicationId: string;
}

export async function listGrantsForApplication(
  applicationId: string,
): Promise<ResourceGrantView[]> {
  const rows = await db
    .select({
      grant: resourceGrants,
      resourceUri: resourcesTable.uri,
      resourceDisplayName: resourcesTable.displayName,
      applicationId: resourcesTable.applicationId,
    })
    .from(resourceGrants)
    .innerJoin(resourcesTable, eq(resourceGrants.resourceId, resourcesTable.id))
    .where(eq(resourcesTable.applicationId, applicationId))
    .orderBy(desc(resourceGrants.createdAt));
  return rows.map((row) => ({
    ...row.grant,
    resourceUri: row.resourceUri,
    resourceDisplayName: row.resourceDisplayName,
    applicationId: row.applicationId,
  }));
}

export async function resolveGrantsForSubject(
  subjectId: string,
  resourceId: string,
  now: Date = new Date(),
): Promise<ResourceGrantRow[]> {
  const [resource] = await db
    .select({ applicationId: resourcesTable.applicationId })
    .from(resourcesTable)
    .where(eq(resourcesTable.id, resourceId))
    .limit(1);
  if (!resource) return [];

  const orgRows = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, subjectId));
  const orgIds = orgRows.map((row) => row.organizationId);

  const planRows = await db
    .select({ planId: userSubscriptions.planId })
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, subjectId),
        eq(userSubscriptions.applicationId, resource.applicationId),
        eq(userSubscriptions.isActive, true),
        or(
          isNull(userSubscriptions.expiresAt),
          gt(userSubscriptions.expiresAt, now),
        ),
      ),
    );
  const planIds = planRows.map((row) => row.planId);

  return db
    .select()
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceId, resourceId),
        isNull(resourceGrants.revokedAt),
        or(isNull(resourceGrants.expiresAt), gt(resourceGrants.expiresAt, now)),
        or(
          and(
            eq(resourceGrants.subjectType, "user"),
            eq(resourceGrants.subjectId, subjectId),
          ),
          eq(resourceGrants.subjectType, "everyone"),
          orgIds.length > 0
            ? and(
                eq(resourceGrants.subjectType, "organization"),
                inArray(resourceGrants.subjectId, orgIds),
              )
            : undefined,
          planIds.length > 0
            ? and(
                eq(resourceGrants.subjectType, "plan"),
                inArray(resourceGrants.subjectId, planIds),
              )
            : undefined,
        ),
      ),
    );
}
