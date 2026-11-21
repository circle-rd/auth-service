import { and, count, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
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
import { enqueueResourceWebhookEvent } from "./webhooks.js";

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
  // Resolve the resource and subject before opening a transaction so the
  // connection is not held while these global-pool reads run.
  const resource = await getResource(input.resourceId);
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
      permission: "use",
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
  await enqueueResourceWebhookEvent({
    type: "resource.grant.revoked",
    resource,
    grant: {
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      expiresAt: row.expiresAt,
    },
  });
  return row;
}

export async function listGrantsForResource(
  resourceId: string,
): Promise<(ResourceGrantRow & { subjectLabel: string | null })[]> {
  const rows = await db
    .select()
    .from(resourceGrants)
    .where(eq(resourceGrants.resourceId, resourceId))
    .orderBy(desc(resourceGrants.createdAt));
  return enrichGrantSubjects(rows);
}

/** Active grants for several resources, used by the owned-resources listing. */
export async function listGrantsForResources(
  resourceIds: string[],
): Promise<ResourceGrantView[]> {
  if (resourceIds.length === 0) return [];
  const rows = await db
    .select({
      grant: resourceGrants,
      resourceUri: resourcesTable.uri,
      resourceDisplayName: resourcesTable.displayName,
      resourceScheme: resourcesTable.scheme,
      applicationId: resourcesTable.applicationId,
    })
    .from(resourceGrants)
    .innerJoin(resourcesTable, eq(resourceGrants.resourceId, resourcesTable.id))
    .where(
      and(
        inArray(resourceGrants.resourceId, resourceIds),
        isNull(resourceGrants.revokedAt),
        or(
          isNull(resourceGrants.expiresAt),
          gt(resourceGrants.expiresAt, new Date()),
        ),
      ),
    )
    .orderBy(desc(resourceGrants.createdAt));
  const enriched = await enrichGrantSubjects(rows.map((row) => row.grant));
  const byId = new Map(enriched.map((grant) => [grant.id, grant]));
  return rows.map((row) => ({
    ...(byId.get(row.grant.id) ?? row.grant),
    resourceUri: row.resourceUri,
    resourceDisplayName: row.resourceDisplayName,
    resourceScheme: row.resourceScheme,
    applicationId: row.applicationId,
    subjectLabel: byId.get(row.grant.id)?.subjectLabel ?? null,
  }));
}

/** Number of currently active grants per resource. */
export async function listActiveGrantCounts(
  resourceIds: string[],
): Promise<Map<string, number>> {
  if (resourceIds.length === 0) return new Map();
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId, total: count() })
    .from(resourceGrants)
    .where(
      and(
        inArray(resourceGrants.resourceId, resourceIds),
        isNull(resourceGrants.revokedAt),
        or(
          isNull(resourceGrants.expiresAt),
          gt(resourceGrants.expiresAt, new Date()),
        ),
      ),
    )
    .groupBy(resourceGrants.resourceId);
  return new Map(rows.map((row) => [row.resourceId, Number(row.total)]));
}

export interface ResourceGrantView extends ResourceGrantRow {
  resourceUri: string;
  resourceDisplayName: string;
  resourceScheme: string;
  applicationId: string;
  // Human-readable recipient, null for `everyone` (the UI renders that label).
  subjectLabel: string | null;
}

/**
 * Resolve recipient ids to names/emails so callers never render a raw subject
 * id. One query per subject type, whatever the number of grants.
 */
export async function enrichGrantSubjects<
  T extends {
    subjectType: ResourceSubjectType;
    subjectId: string | null;
  },
>(grants: T[]): Promise<(T & { subjectLabel: string | null })[]> {
  const userIds = new Set<string>();
  const organizationIds = new Set<string>();
  const planIds = new Set<string>();
  for (const grant of grants) {
    if (!grant.subjectId) continue;
    if (grant.subjectType === "user") userIds.add(grant.subjectId);
    else if (grant.subjectType === "organization")
      organizationIds.add(grant.subjectId);
    else if (grant.subjectType === "plan") planIds.add(grant.subjectId);
  }
  const [userRows, organizationRows, planRows] = await Promise.all([
    userIds.size > 0
      ? db
          .select({
            id: userTable.id,
            name: userTable.name,
            email: userTable.email,
          })
          .from(userTable)
          .where(inArray(userTable.id, [...userIds]))
      : Promise.resolve([]),
    organizationIds.size > 0
      ? db
          .select({ id: organization.id, name: organization.name })
          .from(organization)
          .where(inArray(organization.id, [...organizationIds]))
      : Promise.resolve([]),
    planIds.size > 0
      ? db
          .select({ id: subscriptionPlans.id, name: subscriptionPlans.name })
          .from(subscriptionPlans)
          .where(inArray(subscriptionPlans.id, [...planIds]))
      : Promise.resolve([]),
  ]);
  const labels = new Map<string, string>();
  for (const row of userRows) {
    labels.set(`user:${row.id}`, row.name || row.email || row.id);
  }
  for (const row of organizationRows) {
    labels.set(`organization:${row.id}`, row.name);
  }
  for (const row of planRows) {
    labels.set(`plan:${row.id}`, row.name);
  }
  return grants.map((grant) => ({
    ...grant,
    subjectLabel: grant.subjectId
      ? (labels.get(`${grant.subjectType}:${grant.subjectId}`) ?? null)
      : null,
  }));
}

export async function listGrantsForApplication(
  applicationId: string,
): Promise<ResourceGrantView[]> {
  const rows = await db
    .select({
      grant: resourceGrants,
      resourceUri: resourcesTable.uri,
      resourceDisplayName: resourcesTable.displayName,
      resourceScheme: resourcesTable.scheme,
      applicationId: resourcesTable.applicationId,
    })
    .from(resourceGrants)
    .innerJoin(resourcesTable, eq(resourceGrants.resourceId, resourcesTable.id))
    .where(eq(resourcesTable.applicationId, applicationId))
    .orderBy(desc(resourceGrants.createdAt));
  const enriched = await enrichGrantSubjects(rows.map((row) => row.grant));
  const byId = new Map(enriched.map((grant) => [grant.id, grant]));
  return rows.map((row) => ({
    ...(byId.get(row.grant.id) ?? row.grant),
    resourceUri: row.resourceUri,
    resourceDisplayName: row.resourceDisplayName,
    resourceScheme: row.resourceScheme,
    applicationId: row.applicationId,
    subjectLabel: byId.get(row.grant.id)?.subjectLabel ?? null,
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
