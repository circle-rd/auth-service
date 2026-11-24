import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  resourceGrants,
  resources as resourcesTable,
} from "../../db/resource-schema.js";
import { listActivePlanIds, listOrganizationIds } from "./identity-facts.js";
import type { ResourceGrantRow } from "./grants.js";

export interface ResolveGrantsOptions {
  // Plans belong to an application, so a plan grant only counts for access
  // through the application that owns the resource.
  includePlans: boolean;
}

export async function resolveGrantsForSubject(
  subjectId: string,
  resourceId: string,
  now: Date = new Date(),
  options: ResolveGrantsOptions = { includePlans: true },
): Promise<ResourceGrantRow[]> {
  const [resource] = await db
    .select({ applicationId: resourcesTable.applicationId })
    .from(resourcesTable)
    .where(eq(resourcesTable.id, resourceId))
    .limit(1);
  if (!resource) return [];

  const orgIds = await listOrganizationIds(subjectId);
  const planIds = options.includePlans
    ? [
        ...((
          await listActivePlanIds(subjectId, [resource.applicationId], now)
        ).get(resource.applicationId) ?? []),
      ]
    : [];

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

/** The unrevoked, unexpired grants that open a resource to one application. */
export async function resolveApplicationGrants(
  resourceId: string,
  applicationSlug: string,
  now: Date = new Date(),
): Promise<ResourceGrantRow[]> {
  return db
    .select()
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceId, resourceId),
        eq(resourceGrants.subjectType, "application"),
        eq(resourceGrants.subjectId, applicationSlug),
        isNull(resourceGrants.revokedAt),
        or(isNull(resourceGrants.expiresAt), gt(resourceGrants.expiresAt, now)),
      ),
    );
}
