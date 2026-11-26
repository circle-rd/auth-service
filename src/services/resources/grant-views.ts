import { and, count, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications, subscriptionPlans } from "../../db/schema.js";
import { organization, user as userTable } from "../../db/auth-schema.js";
import {
  resourceGrants,
  resources as resourcesTable,
} from "../../db/resource-schema.js";
import type { ResourceGrantRow } from "./grants.js";
import type { ResourceSubjectType } from "./types.js";

export async function listGrantsForResource(resourceId: string): Promise<
  (ResourceGrantRow & {
    subjectLabel: string | null;
    subjectUsername: string | null;
  })[]
> {
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
    subjectUsername: byId.get(row.grant.id)?.subjectUsername ?? null,
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
  // Account-wide pseudo for a user grant, never an e-mail.
  subjectUsername: string | null;
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
>(
  grants: T[],
): Promise<
  (T & { subjectLabel: string | null; subjectUsername: string | null })[]
> {
  const userIds = new Set<string>();
  const organizationIds = new Set<string>();
  const planIds = new Set<string>();
  const applicationSlugs = new Set<string>();
  for (const grant of grants) {
    if (!grant.subjectId) continue;
    if (grant.subjectType === "application") {
      applicationSlugs.add(grant.subjectId);
    } else if (grant.subjectType === "user") userIds.add(grant.subjectId);
    else if (grant.subjectType === "organization")
      organizationIds.add(grant.subjectId);
    else if (grant.subjectType === "plan") planIds.add(grant.subjectId);
  }
  const [userRows, organizationRows, planRows, applicationRows] =
    await Promise.all([
      userIds.size > 0
        ? db
            .select({
              id: userTable.id,
              name: userTable.name,
              email: userTable.email,
              username: userTable.username,
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
      applicationSlugs.size > 0
        ? db
            .select({ slug: applications.slug, name: applications.name })
            .from(applications)
            .where(inArray(applications.slug, [...applicationSlugs]))
        : Promise.resolve([]),
    ]);
  const labels = new Map<string, string>();
  const usernames = new Map<string, string>();
  for (const row of userRows) {
    labels.set(`user:${row.id}`, row.name || row.email || row.id);
    if (row.username) usernames.set(`user:${row.id}`, row.username);
  }
  for (const row of organizationRows) {
    labels.set(`organization:${row.id}`, row.name);
  }
  for (const row of planRows) {
    labels.set(`plan:${row.id}`, row.name);
  }
  for (const row of applicationRows) {
    labels.set(`application:${row.slug}`, row.name);
  }
  return grants.map((grant) => ({
    ...grant,
    subjectLabel: grant.subjectId
      ? (labels.get(`${grant.subjectType}:${grant.subjectId}`) ?? null)
      : null,
    subjectUsername: grant.subjectId
      ? (usernames.get(`${grant.subjectType}:${grant.subjectId}`) ?? null)
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
    subjectUsername: byId.get(row.grant.id)?.subjectUsername ?? null,
  }));
}
