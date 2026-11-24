import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import { evaluateResourceAccessBatch, type AccessKind } from "./policy.js";
import {
  listValidatedResources,
  listValidatedResourcesBySchemes,
  type ResourceView,
} from "./registry.js";
import type { ResourcePermission, ResourceSubjectType } from "./types.js";

export interface CatalogueApplication {
  slug: string;
  name: string;
}

export interface AccessibleResource {
  resourceId: string;
  resourceUri: string;
  scheme: string;
  displayName: string;
  applicationId: string;
  applicationSlug: string;
  applicationName: string;
  ownerType: "user" | "application";
  ownerId: string;
  accessKind: AccessKind;
  permission: ResourcePermission;
  grantSubjectType?: ResourceSubjectType;
}

export interface AccessibleResourceInput {
  subjectId: string;
  scheme?: string;
  now?: Date;
}

function toAccessible(
  resource: ResourceView,
  decision: {
    accessKind: AccessKind;
    permission: ResourcePermission;
    grantSubjectType?: ResourceSubjectType;
  },
): AccessibleResource {
  return {
    resourceId: resource.id,
    resourceUri: resource.uri,
    scheme: resource.scheme,
    displayName: resource.displayName,
    applicationId: resource.applicationId,
    applicationSlug: resource.applicationSlug,
    applicationName: resource.applicationName,
    ownerType: resource.ownerType,
    ownerId: resource.ownerId,
    accessKind: decision.accessKind,
    permission: decision.permission,
    grantSubjectType: decision.grantSubjectType,
  };
}

export async function listAccessibleResources(
  input: AccessibleResourceInput,
): Promise<AccessibleResource[]> {
  const resources: ResourceView[] = input.scheme
    ? await listValidatedResourcesBySchemes([input.scheme])
    : await listValidatedResources();
  const decisions = await evaluateResourceAccessBatch(
    resources,
    input.subjectId,
    input.now,
  );
  const accessible: AccessibleResource[] = [];
  for (let index = 0; index < resources.length; index += 1) {
    const decision = decisions[index];
    if (decision?.decision !== "allow") continue;
    accessible.push(toAccessible(resources[index]!, decision));
  }
  return accessible;
}

export async function listSharingApplications(): Promise<
  CatalogueApplication[]
> {
  return db
    .select({ slug: applications.slug, name: applications.name })
    .from(applications)
    .where(
      and(
        eq(applications.resourceSharingEnabled, true),
        eq(applications.isActive, true),
      ),
    )
    .orderBy(asc(applications.name));
}
