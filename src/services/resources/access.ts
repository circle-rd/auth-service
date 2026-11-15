import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import { evaluateResourceAccess, type AccessKind } from "./policy.js";
import {
  listValidatedResources,
  listValidatedResourcesBySchemes,
  type ResourceView,
} from "./registry.js";
import type { ResourceSubjectType } from "./types.js";

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
    grantSubjectType: decision.grantSubjectType,
  };
}

export async function listAccessibleResources(
  input: AccessibleResourceInput,
): Promise<AccessibleResource[]> {
  const resources: ResourceView[] = input.scheme
    ? await listValidatedResourcesBySchemes([input.scheme])
    : await listValidatedResources();
  const accessible: AccessibleResource[] = [];
  for (const resource of resources) {
    const decision = await evaluateResourceAccess({
      resource,
      subjectId: input.subjectId,
      now: input.now,
    });
    if (decision.decision !== "allow") continue;
    accessible.push(toAccessible(resource, decision));
  }
  return accessible;
}

export async function listSharingApplications(): Promise<
  CatalogueApplication[]
> {
  return db
    .select({ slug: applications.slug, name: applications.name })
    .from(applications)
    .where(eq(applications.resourceSharingEnabled, true))
    .orderBy(asc(applications.name));
}
