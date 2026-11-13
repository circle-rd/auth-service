import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applications,
  sharedResources,
  subscriptionPlans,
} from "../../db/schema.js";
import { ERR } from "../../errors.js";
import {
  normalizeResourceKey,
  normalizeResourceSlug,
  type ResourceType,
} from "../resource-uri.js";
import {
  isResourceStatus,
  isResourceVisibility,
  type ResourceStatus,
  type ResourceVisibility,
  type SharedResource,
} from "./types.js";

const resourceColumns = {
  id: sharedResources.id,
  ownerApplicationId: sharedResources.ownerApplicationId,
  resourceType: sharedResources.resourceType,
  key: sharedResources.key,
  displayName: sharedResources.displayName,
  upstreamRef: sharedResources.upstreamRef,
  status: sharedResources.status,
  visibility: sharedResources.visibility,
  defaultPlanId: sharedResources.defaultPlanId,
  createdAt: sharedResources.createdAt,
  updatedAt: sharedResources.updatedAt,
} as const;

export interface SharedResourceView extends SharedResource {
  ownerApplicationSlug: string;
}

async function ownerSlug(ownerApplicationId: string): Promise<string> {
  const [app] = await db
    .select({ slug: applications.slug })
    .from(applications)
    .where(eq(applications.id, ownerApplicationId))
    .limit(1);
  if (!app) throw ERR.APP_002();
  return app.slug;
}

async function assertPlanBelongsToOwner(
  planId: string,
  ownerApplicationId: string,
): Promise<void> {
  const [plan] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.id, planId),
        eq(subscriptionPlans.applicationId, ownerApplicationId),
      ),
    )
    .limit(1);
  if (!plan) {
    throw ERR.RES_001("Plan does not belong to the owner application");
  }
}

function assertStatus(status: string): ResourceStatus {
  if (!isResourceStatus(status)) {
    throw ERR.RES_001("Invalid resource status");
  }
  return status;
}

function assertVisibility(visibility: string): ResourceVisibility {
  if (!isResourceVisibility(visibility)) {
    throw ERR.RES_001("Invalid resource visibility");
  }
  return visibility;
}

export interface CreateSharedResourceInput {
  ownerApplicationId: string;
  resourceType: ResourceType;
  slug: string;
  displayName: string;
  upstreamRef?: string | null;
  status?: ResourceStatus;
  visibility?: ResourceVisibility;
  defaultPlanId?: string | null;
}

export async function createSharedResource(
  input: CreateSharedResourceInput,
): Promise<SharedResource> {
  const owner = await ownerSlug(input.ownerApplicationId);
  const slug = normalizeResourceSlug(input.slug);
  const key = normalizeResourceKey(`${owner}/${slug}`).key;
  const status = assertStatus(input.status ?? "draft");
  const visibility = assertVisibility(input.visibility ?? "invited_only");
  if (input.defaultPlanId) {
    await assertPlanBelongsToOwner(
      input.defaultPlanId,
      input.ownerApplicationId,
    );
  }

  const [row] = await db
    .insert(sharedResources)
    .values({
      ownerApplicationId: input.ownerApplicationId,
      resourceType: input.resourceType,
      key,
      displayName: input.displayName,
      upstreamRef: input.upstreamRef ?? null,
      status,
      visibility,
      defaultPlanId: input.defaultPlanId ?? null,
    })
    .onConflictDoNothing({ target: sharedResources.key })
    .returning();
  if (!row) throw ERR.RES_003();
  return row;
}

export async function getSharedResource(id: string): Promise<SharedResource> {
  const [row] = await db
    .select(resourceColumns)
    .from(sharedResources)
    .where(eq(sharedResources.id, id))
    .limit(1);
  if (!row) throw ERR.RES_002();
  return row;
}

export async function listSharedResources(
  ownerApplicationId: string,
): Promise<SharedResource[]> {
  return db
    .select(resourceColumns)
    .from(sharedResources)
    .where(eq(sharedResources.ownerApplicationId, ownerApplicationId))
    .orderBy(desc(sharedResources.createdAt));
}

export async function findResourceByKey(
  key: string,
): Promise<SharedResourceView | null> {
  const normalized = normalizeResourceKey(key);
  const [row] = await db
    .select({
      ...resourceColumns,
      ownerApplicationSlug: applications.slug,
    })
    .from(sharedResources)
    .innerJoin(
      applications,
      eq(sharedResources.ownerApplicationId, applications.id),
    )
    .where(eq(sharedResources.key, normalized.key))
    .limit(1);
  return row ?? null;
}

export async function listPublishedResourcesByType(
  resourceType: ResourceType,
): Promise<SharedResourceView[]> {
  return db
    .select({
      ...resourceColumns,
      ownerApplicationSlug: applications.slug,
    })
    .from(sharedResources)
    .innerJoin(
      applications,
      eq(sharedResources.ownerApplicationId, applications.id),
    )
    .where(
      and(
        eq(sharedResources.resourceType, resourceType),
        eq(sharedResources.status, "published"),
      ),
    );
}

export interface UpdateSharedResourceInput {
  slug?: string;
  displayName?: string;
  upstreamRef?: string | null;
  status?: ResourceStatus;
  visibility?: ResourceVisibility;
  defaultPlanId?: string | null;
}

export async function updateSharedResource(
  id: string,
  patch: UpdateSharedResourceInput,
): Promise<SharedResource> {
  const current = await getSharedResource(id);
  const currentSlug = normalizeResourceKey(current.key).slug;
  const nextSlug =
    patch.slug === undefined ? currentSlug : normalizeResourceSlug(patch.slug);
  if (nextSlug !== currentSlug && current.status !== "draft") {
    throw ERR.RES_006();
  }

  const owner = await ownerSlug(current.ownerApplicationId);
  const key = normalizeResourceKey(`${owner}/${nextSlug}`).key;
  if (key !== current.key) {
    const [existing] = await db
      .select({ id: sharedResources.id })
      .from(sharedResources)
      .where(and(eq(sharedResources.key, key), ne(sharedResources.id, id)))
      .limit(1);
    if (existing) throw ERR.RES_003();
  }

  const status =
    patch.status === undefined ? current.status : assertStatus(patch.status);
  const visibility =
    patch.visibility === undefined
      ? current.visibility
      : assertVisibility(patch.visibility);
  if (patch.defaultPlanId) {
    await assertPlanBelongsToOwner(
      patch.defaultPlanId,
      current.ownerApplicationId,
    );
  }

  const [row] = await db
    .update(sharedResources)
    .set({
      key,
      displayName: patch.displayName ?? current.displayName,
      upstreamRef:
        patch.upstreamRef === undefined
          ? current.upstreamRef
          : patch.upstreamRef,
      status,
      visibility,
      defaultPlanId:
        patch.defaultPlanId === undefined
          ? current.defaultPlanId
          : patch.defaultPlanId,
      updatedAt: new Date(),
    })
    .where(eq(sharedResources.id, id))
    .returning();
  if (!row) throw ERR.RES_002();
  return row;
}
