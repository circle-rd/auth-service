import { formatResourceUri, type ResourceType } from "../resource-uri.js";
import { authorizeResource, type AuthorizeInput } from "./policy.js";
import { listPublishedResourcesByType } from "./registry.js";

export interface AccessibleResource {
  resourceId: string;
  resourceKey: string;
  resourceUri: string;
  resourceType: ResourceType;
  displayName: string;
  ownerApplicationSlug: string;
  planName: string;
  teamId: string;
}

export async function listAccessibleResources(
  input: Omit<AuthorizeInput, "key">,
): Promise<AccessibleResource[]> {
  const candidates = await listPublishedResourcesByType(input.resourceType);
  const accessible: AccessibleResource[] = [];
  for (const resource of candidates) {
    const decision = await authorizeResource(resource, {
      ...input,
      key: resource.key,
    });
    if (decision.decision !== "allow") continue;
    accessible.push({
      resourceId: decision.resourceId,
      resourceKey: decision.resourceKey,
      resourceUri: formatResourceUri(
        decision.resourceType,
        decision.resourceKey,
      ),
      resourceType: decision.resourceType,
      displayName: resource.displayName,
      ownerApplicationSlug: decision.ownerApplicationSlug,
      planName: decision.planName,
      teamId: decision.teamId,
    });
  }
  return accessible;
}
