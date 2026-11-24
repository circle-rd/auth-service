import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import {
  GLOBAL_SCOPE,
  applicationScope,
  type CallerApplication,
} from "./application-scope.js";
import type { AccessKind } from "./policy.js";
import { evaluateResourceAccessBatch } from "./policy-batch.js";
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
  // Omitted for an application that does not own the resource: the owner's
  // identity is not shared across applications.
  ownerId?: string;
  accessKind: AccessKind;
  permission: ResourcePermission;
  grantSubjectType?: ResourceSubjectType;
}

export interface AccessibleResourceInput {
  subjectId: string;
  scheme?: string;
  // The calling application. Without it the view is the user's global one.
  caller?: CallerApplication;
  now?: Date;
}

function toAccessible(
  resource: ResourceView,
  decision: {
    accessKind: AccessKind;
    permission: ResourcePermission;
    grantSubjectType?: ResourceSubjectType;
  },
  caller: CallerApplication | undefined,
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
    ...(!caller || caller.id === resource.applicationId
      ? { ownerId: resource.ownerId }
      : {}),
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
    {
      scope: input.caller ? applicationScope(input.caller) : GLOBAL_SCOPE,
      now: input.now,
    },
  );
  const accessible: AccessibleResource[] = [];
  for (let index = 0; index < resources.length; index += 1) {
    const decision = decisions[index];
    if (decision?.decision !== "allow") continue;
    accessible.push(toAccessible(resources[index]!, decision, input.caller));
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
