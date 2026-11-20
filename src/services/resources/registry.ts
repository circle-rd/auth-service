import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import { resources } from "../../db/resource-schema.js";
import { ERR } from "../../errors.js";
import type { DbExecutor } from "../credential-user.js";
import {
  assertCanManageResource,
  isActiveMember,
  isGuest,
} from "./authority.js";
import { assertSchemeEnabledForApplication } from "./scheme-service.js";
import type { ResourceOwnerType, ResourceStatus } from "./types.js";
import {
  adapterForScheme,
  assertLocator,
  buildResourceUri,
  parseResourceUri,
} from "./uri.js";

export type ResourceRow = typeof resources.$inferSelect;

export interface ResourceView extends ResourceRow {
  applicationSlug: string;
  applicationName: string;
  resourceSharingEnabled: boolean;
  applicationActive: boolean;
}

const resourceColumns = {
  id: resources.id,
  applicationId: resources.applicationId,
  scheme: resources.scheme,
  locator: resources.locator,
  uri: resources.uri,
  displayName: resources.displayName,
  ownerType: resources.ownerType,
  ownerId: resources.ownerId,
  status: resources.status,
  listed: resources.listed,
  metadata: resources.metadata,
  validationRequestedAt: resources.validationRequestedAt,
  validatedAt: resources.validatedAt,
  validationError: resources.validationError,
  createdAt: resources.createdAt,
  updatedAt: resources.updatedAt,
} as const;

const viewColumns = {
  ...resourceColumns,
  applicationSlug: applications.slug,
  applicationName: applications.name,
  resourceSharingEnabled: applications.resourceSharingEnabled,
  applicationActive: applications.isActive,
} as const;

export interface CreateResourceInput {
  applicationId: string;
  scheme: string;
  locator?: string | null;
  displayName: string;
  ownerType: ResourceOwnerType;
  ownerId: string;
  metadata?: Record<string, unknown>;
}

export async function createResource(
  input: CreateResourceInput,
): Promise<ResourceView> {
  await assertSchemeEnabledForApplication(input.applicationId, input.scheme);
  if (input.ownerType === "user") {
    if (!(await isActiveMember(input.ownerId, input.applicationId))) {
      throw ERR.RES_004();
    }
    if (await isGuest(input.ownerId, input.applicationId)) {
      throw ERR.AUTH_011("A guest cannot create resources");
    }
  }
  if (
    input.ownerType === "application" &&
    input.ownerId !== input.applicationId
  ) {
    throw ERR.RES_001("Application-owned resources must use their application");
  }
  if (input.ownerType === "user" && input.ownerId.trim() === "") {
    throw ERR.RES_001("A user owner is required");
  }
  const displayName = input.displayName.trim();
  if (displayName === "") throw ERR.RES_001("A display name is required");

  const locator =
    input.scheme === "ssh" ? randomUUID() : (input.locator ?? "").trim();
  if (locator === "") throw ERR.RES_005("A resource locator is required");
  assertLocator(input.scheme, locator);
  const uri = buildResourceUri(input.scheme, locator);

  const [app] = await db
    .select({
      slug: applications.slug,
      name: applications.name,
      resourceSharingEnabled: applications.resourceSharingEnabled,
      applicationActive: applications.isActive,
    })
    .from(applications)
    .where(eq(applications.id, input.applicationId))
    .limit(1);
  if (!app) throw ERR.RES_004();
  if (adapterForScheme(input.scheme) === "litellm") {
    if (locator.split("/")[0] !== app.slug) {
      throw ERR.RES_005("The locator must start with the application slug");
    }
  }

  const [row] = await db
    .insert(resources)
    .values({
      applicationId: input.applicationId,
      scheme: input.scheme,
      locator,
      uri,
      displayName,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      status: "pending_validation",
      listed: false,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw ERR.RES_003();

  return {
    ...row,
    applicationSlug: app.slug,
    applicationName: app.name,
    resourceSharingEnabled: app.resourceSharingEnabled,
    applicationActive: app.applicationActive,
  };
}

export async function getResource(id: string): Promise<ResourceView> {
  const [row] = await db
    .select(viewColumns)
    .from(resources)
    .innerJoin(applications, eq(resources.applicationId, applications.id))
    .where(eq(resources.id, id))
    .limit(1);
  if (!row) throw ERR.RES_002();
  return row;
}

export async function findResourceByUri(
  uri: string,
): Promise<ResourceView | null> {
  const parsed = parseResourceUri(uri);
  const [row] = await db
    .select(viewColumns)
    .from(resources)
    .innerJoin(applications, eq(resources.applicationId, applications.id))
    .where(eq(resources.uri, parsed.uri))
    .limit(1);
  return row ?? null;
}

export async function listResourcesForOwner(
  ownerType: ResourceOwnerType,
  ownerId: string,
  applicationId?: string,
): Promise<ResourceView[]> {
  return db
    .select(viewColumns)
    .from(resources)
    .innerJoin(applications, eq(resources.applicationId, applications.id))
    .where(
      and(
        eq(resources.ownerType, ownerType),
        eq(resources.ownerId, ownerId),
        eq(applications.resourceSharingEnabled, true),
        eq(applications.isActive, true),
        applicationId ? eq(resources.applicationId, applicationId) : undefined,
      ),
    )
    .orderBy(desc(resources.createdAt));
}

export async function listResourcesForApplication(
  applicationId: string,
): Promise<ResourceView[]> {
  return db
    .select(viewColumns)
    .from(resources)
    .innerJoin(applications, eq(resources.applicationId, applications.id))
    .where(
      and(
        eq(resources.applicationId, applicationId),
        eq(applications.resourceSharingEnabled, true),
        eq(applications.isActive, true),
      ),
    )
    .orderBy(desc(resources.createdAt));
}

export async function listValidatedResourcesBySchemes(
  schemes: readonly string[],
): Promise<ResourceView[]> {
  if (schemes.length === 0) return [];
  return db
    .select(viewColumns)
    .from(resources)
    .innerJoin(applications, eq(resources.applicationId, applications.id))
    .where(
      and(
        eq(resources.status, "validated"),
        eq(applications.resourceSharingEnabled, true),
        eq(applications.isActive, true),
        inArray(resources.scheme, [...schemes]),
      ),
    );
}

export async function listValidatedResources(): Promise<ResourceView[]> {
  return db
    .select(viewColumns)
    .from(resources)
    .innerJoin(applications, eq(resources.applicationId, applications.id))
    .where(
      and(
        eq(resources.status, "validated"),
        eq(applications.resourceSharingEnabled, true),
        eq(applications.isActive, true),
      ),
    )
    .orderBy(desc(resources.createdAt));
}

export interface UpdateResourceInput {
  displayName?: string;
  listed?: boolean;
  metadata?: Record<string, unknown>;
}

export async function updateResource(
  id: string,
  actorUserId: string,
  patch: UpdateResourceInput,
): Promise<ResourceView> {
  const current = await getResource(id);
  await assertCanManageResource(actorUserId, current);
  if (patch.displayName !== undefined && patch.displayName.trim() === "") {
    throw ERR.RES_001("A display name is required");
  }
  const [row] = await db
    .update(resources)
    .set({
      displayName: patch.displayName?.trim(),
      listed: patch.listed,
      metadata: patch.metadata,
      updatedAt: new Date(),
    })
    .where(eq(resources.id, id))
    .returning();
  if (!row) throw ERR.RES_002();
  return { ...current, ...row };
}

export async function requestResourceValidation(
  id: string,
  actorUserId: string,
): Promise<ResourceView> {
  const current = await getResource(id);
  await assertCanManageResource(actorUserId, current);
  return transitionValidation(id, current, [
    "pending_validation",
    "validation_failed",
  ]);
}

export async function markResourceValidated(
  id: string,
  exec: DbExecutor = db,
): Promise<ResourceView> {
  const current = await getResource(id);
  if (current.status === "disabled") throw ERR.RES_001("Resource is disabled");
  const [row] = await exec
    .update(resources)
    .set({
      status: "validated",
      validatedAt: new Date(),
      validationError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(resources.id, id), ne(resources.status, "disabled")))
    .returning();
  if (!row) throw ERR.RES_001("Resource is disabled");
  return { ...current, ...row };
}

export async function markResourceValidationFailed(
  id: string,
  reason: string,
): Promise<ResourceView> {
  const current = await getResource(id);
  if (current.status === "disabled") throw ERR.RES_001("Resource is disabled");
  const [row] = await db
    .update(resources)
    .set({
      status: "validation_failed",
      validationError: reason.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(and(eq(resources.id, id), ne(resources.status, "disabled")))
    .returning();
  if (!row) throw ERR.RES_001("Resource is disabled");
  return { ...current, ...row };
}

export async function markResourceInvalidated(
  id: string,
  reason: string,
): Promise<ResourceView> {
  const current = await getResource(id);
  const [row] = await db
    .update(resources)
    .set({
      status: "disabled",
      validationError: reason.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(resources.id, id))
    .returning();
  if (!row) throw ERR.RES_002();
  return { ...current, ...row };
}

export async function disableResource(
  id: string,
  actorUserId: string,
): Promise<ResourceView> {
  const current = await getResource(id);
  await assertCanManageResource(actorUserId, current);
  const [row] = await db
    .update(resources)
    .set({ status: "disabled", updatedAt: new Date() })
    .where(eq(resources.id, id))
    .returning();
  if (!row) throw ERR.RES_002();
  return { ...current, ...row };
}

/**
 * Remove a resource the owner no longer wants. One that was never validated
 * could not be used, so it has no history worth keeping and is deleted; any
 * other is disabled, which keeps its grants, events and usage.
 */
export async function removeResource(
  id: string,
  actorUserId: string,
): Promise<{ resource: ResourceView; removed: boolean }> {
  const current = await getResource(id);
  await assertCanManageResource(actorUserId, current);
  // The predicate is re-checked by the database: a validation that lands
  // between the read above and this delete leaves the row in place.
  const deleted = await db
    .delete(resources)
    .where(and(eq(resources.id, id), isNull(resources.validatedAt)))
    .returning({ id: resources.id });
  if (deleted.length > 0) return { resource: current, removed: true };
  return { resource: await disableResource(id, actorUserId), removed: false };
}

async function transitionValidation(
  id: string,
  current: ResourceView,
  allowedFrom: readonly ResourceStatus[],
): Promise<ResourceView> {
  if (!allowedFrom.includes(current.status)) {
    throw ERR.RES_001("Resource cannot be validated in its current state");
  }
  const [row] = await db
    .update(resources)
    .set({
      status: "pending_validation",
      validationRequestedAt: new Date(),
      validationError: null,
      updatedAt: new Date(),
    })
    .where(eq(resources.id, id))
    .returning();
  if (!row) throw ERR.RES_002();
  return { ...current, ...row };
}
