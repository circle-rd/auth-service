import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import {
  formatResourceUri,
  RESOURCE_TYPES,
  type ResourceType,
} from "../resource-uri.js";
import { evaluateSubjectAccess, loadPolicyGrant } from "./policy.js";
import { listPublishedResourcesByType } from "./registry.js";

export interface CatalogueApplication {
  slug: string;
  name: string;
}

export interface ResourceCatalogueItem {
  resourceId: string;
  resourceKey: string;
  resourceUri: string;
  resourceType: ResourceType;
  displayName: string;
  ownerApplicationSlug: string;
  ownerApplicationName: string;
  planName: string;
  restrictedToClientIds: string[] | null;
}

/**
 * Applications that offer sharing, including those where the subject has no
 * accessible resource. The page groups the catalogue by application without a
 * second endpoint.
 */
export async function listSharingApplications(): Promise<
  CatalogueApplication[]
> {
  return db
    .select({ slug: applications.slug, name: applications.name })
    .from(applications)
    .where(eq(applications.resourceSharingEnabled, true))
    .orderBy(asc(applications.name));
}

/**
 * Subject-scoped discovery only. Admission re-evaluates subject/client/resource
 * on every gateway request, so this list must never be treated as an
 * authorization decision.
 */
export async function listResourceCatalogue(input: {
  subjectId: string;
  now?: Date;
}): Promise<ResourceCatalogueItem[]> {
  const now = input.now ?? new Date();
  const items: ResourceCatalogueItem[] = [];
  for (const resourceType of RESOURCE_TYPES) {
    const resources = await listPublishedResourcesByType(resourceType);
    for (const resource of resources) {
      const grant = await loadPolicyGrant(resource, input.subjectId);
      const access = evaluateSubjectAccess(resource, grant, now);
      if (!access.allowed) continue;
      if (
        access.grant.allowedClientIds !== null &&
        access.grant.allowedClientIds.length === 0
      ) {
        continue;
      }
      items.push({
        resourceId: resource.id,
        resourceKey: resource.key,
        resourceUri: formatResourceUri(resource.resourceType, resource.key),
        resourceType: resource.resourceType,
        displayName: resource.displayName,
        ownerApplicationSlug: resource.ownerApplicationSlug,
        ownerApplicationName: resource.ownerApplicationName,
        planName: access.planName,
        restrictedToClientIds: access.grant.allowedClientIds,
      });
    }
  }
  return items;
}
