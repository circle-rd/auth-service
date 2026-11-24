import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import type { ResourceGrantRow } from "./grants.js";
import { raisePermission, type ResourcePermission } from "./types.js";

export interface CallerApplication {
  id: string;
  slug: string;
}

/**
 * Where a decision is taken. `global` is the user's own catalogue in the
 * auth-service UI; `application` is the view of one calling application, which
 * only reaches what it owns or what was shared with it.
 */
export type AccessScope =
  { kind: "global" } | { kind: "application"; caller: CallerApplication };

export const GLOBAL_SCOPE: AccessScope = { kind: "global" };

export function applicationScope(caller: CallerApplication): AccessScope {
  return { kind: "application", caller };
}

/**
 * The level an application holds on a resource: `write` on its own, otherwise
 * the strongest application grant that names it, or null when none does.
 */
export function applicationScopeLevel(
  resourceApplicationId: string,
  caller: CallerApplication,
  applicationGrants: readonly ResourceGrantRow[],
): ResourcePermission | null {
  if (resourceApplicationId === caller.id) return "write";
  let level: ResourcePermission | null = null;
  for (const grant of applicationGrants) {
    if (grant.subjectType !== "application") continue;
    if (grant.subjectId !== caller.slug) continue;
    level = level ? raisePermission(level, grant.permission) : grant.permission;
  }
  return level;
}

export interface SharingApplication extends CallerApplication {
  allowedResources: string[];
}

/** The application when it is active and has resource sharing enabled. */
export async function loadSharingApplication(
  applicationId: string,
): Promise<SharingApplication | null> {
  const [row] = await db
    .select({
      id: applications.id,
      slug: applications.slug,
      isActive: applications.isActive,
      sharing: applications.resourceSharingEnabled,
      allowedResources: applications.allowedResources,
    })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!row?.isActive || !row.sharing) return null;
  return {
    id: row.id,
    slug: row.slug,
    allowedResources: row.allowedResources,
  };
}
