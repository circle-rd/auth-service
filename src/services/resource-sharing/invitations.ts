import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import {
  applications,
  resourceInvitations,
  sharedResources,
  subscriptionPlans,
} from "../../db/schema.js";
import { ERR } from "../../errors.js";
import type { DbExecutor } from "../credential-user.js";
import {
  assertApplicationExists,
  assertPlanBelongsToOwner,
  assertResourceBelongsToOwner,
  createResourceGrant,
  type ResourceGrant,
} from "./grants.js";

export const RESOURCE_INVITATION_TTL_HOURS = 72;
export const RESOURCE_INVITATION_MAX_TTL_HOURS = 168;

export type ResourceInvitation = typeof resourceInvitations.$inferSelect;
export type ResourceInvitationState =
  "pending" | "consumed" | "revoked" | "expired";

export function toPublicResourceInvitation(invitation: ResourceInvitation) {
  const { tokenHash: _tokenHash, ...rest } = invitation;
  void _tokenHash;
  return rest;
}

export type PublicResourceInvitation = ReturnType<
  typeof toPublicResourceInvitation
>;

export function hashResourceInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function resourceInvitationState(
  invitation: ResourceInvitation,
  now: Date = new Date(),
): ResourceInvitationState {
  if (invitation.revokedAt) return "revoked";
  if (invitation.consumedAt) return "consumed";
  if (invitation.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

export function buildResourceInvitationUrl(token: string): string {
  return `${config.betterAuth.url}/resource-invitation?token=${encodeURIComponent(
    token,
  )}`;
}

export interface CreateResourceInvitationInput {
  email: string;
  ownerApplicationId: string;
  planId: string;
  resourceId?: string | null;
  allowedClientIds?: string[] | null;
  ttlHours?: number;
  createdBy: string;
}

export async function createResourceInvitation(
  input: CreateResourceInvitationInput,
  exec: DbExecutor = db,
): Promise<{
  invitation: ResourceInvitation;
  token: string;
  ownerAppSlug: string;
  ownerAppName: string;
  planName: string;
  resourceName: string | null;
}> {
  await assertApplicationExists(input.ownerApplicationId, exec);
  await assertPlanBelongsToOwner(input.planId, input.ownerApplicationId, exec);
  if (input.resourceId) {
    await assertResourceBelongsToOwner(
      input.resourceId,
      input.ownerApplicationId,
      exec,
    );
  }
  if (input.allowedClientIds && input.allowedClientIds.length === 0) {
    throw ERR.RES_001("allowedClientIds must not be empty");
  }

  const ttlHours = input.ttlHours ?? RESOURCE_INVITATION_TTL_HOURS;
  if (
    !Number.isInteger(ttlHours) ||
    ttlHours < 1 ||
    ttlHours > RESOURCE_INVITATION_MAX_TTL_HOURS
  ) {
    throw ERR.RES_001("Invalid invitation lifetime");
  }

  const token = randomBytes(32).toString("base64url");
  const [invitation] = await exec
    .insert(resourceInvitations)
    .values({
      tokenHash: hashResourceInvitationToken(token),
      email: input.email.trim().toLowerCase(),
      ownerApplicationId: input.ownerApplicationId,
      resourceId: input.resourceId ?? null,
      planId: input.planId,
      allowedClientIds: input.allowedClientIds
        ? [...new Set(input.allowedClientIds)]
        : null,
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
      createdBy: input.createdBy,
    })
    .returning();
  if (!invitation)
    throw ERR.RES_001("Resource invitation could not be created");

  const [app] = await exec
    .select({ slug: applications.slug, name: applications.name })
    .from(applications)
    .where(eq(applications.id, input.ownerApplicationId))
    .limit(1);
  const [plan] = await exec
    .select({ name: subscriptionPlans.name })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, input.planId))
    .limit(1);
  const resourceName = input.resourceId
    ? ((
        await exec
          .select({ name: sharedResources.displayName })
          .from(sharedResources)
          .where(eq(sharedResources.id, input.resourceId))
          .limit(1)
      )[0]?.name ?? null)
    : null;

  return {
    invitation,
    token,
    ownerAppSlug: app?.slug ?? "",
    ownerAppName: app?.name ?? "",
    planName: plan?.name ?? "",
    resourceName,
  };
}

export async function findResourceInvitationByToken(
  token: string,
): Promise<ResourceInvitation | null> {
  const [row] = await db
    .select()
    .from(resourceInvitations)
    .where(
      eq(resourceInvitations.tokenHash, hashResourceInvitationToken(token)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Redeem an invitation for the authenticated subject. The email match is
 * re-checked here; a valid session for another address cannot claim the grant.
 * Claiming and grant creation share one transaction so a token is never spent
 * without its grant.
 */
export async function acceptResourceInvitation(opts: {
  token: string;
  subjectId: string;
  email: string;
  emailVerified: boolean;
  now?: Date;
}): Promise<ResourceGrant> {
  const invitation = await findResourceInvitationByToken(opts.token);
  if (!invitation) throw ERR.RES_010();
  const state = resourceInvitationState(invitation, opts.now);
  if (state !== "pending") throw ERR.RES_010();
  if (
    invitation.email.trim().toLowerCase() !== opts.email.trim().toLowerCase()
  ) {
    throw ERR.AUTH_014();
  }
  if (!opts.emailVerified) throw ERR.AUTH_015();

  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(resourceInvitations)
      .set({ consumedAt: now })
      .where(
        and(
          eq(resourceInvitations.id, invitation.id),
          isNull(resourceInvitations.consumedAt),
          isNull(resourceInvitations.revokedAt),
          gt(resourceInvitations.expiresAt, now),
        ),
      )
      .returning({ id: resourceInvitations.id });
    if (!claimed) throw ERR.RES_010();

    return createResourceGrant(
      {
        subjectId: opts.subjectId,
        ownerApplicationId: invitation.ownerApplicationId,
        resourceId: invitation.resourceId,
        planId: invitation.planId,
        allowedClientIds: invitation.allowedClientIds,
        expiresAt: null,
        createdBy: invitation.createdBy,
      },
      tx,
    );
  });
}

export async function revokeResourceInvitation(
  id: string,
  ownerApplicationId: string,
): Promise<ResourceInvitation> {
  const [revoked] = await db
    .update(resourceInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(resourceInvitations.id, id),
        eq(resourceInvitations.ownerApplicationId, ownerApplicationId),
        isNull(resourceInvitations.consumedAt),
        isNull(resourceInvitations.revokedAt),
      ),
    )
    .returning();
  if (!revoked) throw ERR.RES_010();
  return revoked;
}

export interface OwnerResourceInvitationView {
  id: string;
  email: string;
  planId: string;
  planName: string;
  resourceId: string | null;
  resourceName: string | null;
  allowedClientIds: string[] | null;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  state: ResourceInvitationState;
}

/**
 * Pending and historical invitations of one owner application. The token hash
 * never leaves the database. Foreign or missing application ids never reach
 * this query because the route resolves the owner through the delegated guard.
 */
export async function listResourceInvitationsForOwner(
  ownerApplicationId: string,
  now: Date = new Date(),
): Promise<OwnerResourceInvitationView[]> {
  const rows = await db
    .select({
      id: resourceInvitations.id,
      email: resourceInvitations.email,
      planId: resourceInvitations.planId,
      planName: subscriptionPlans.name,
      resourceId: resourceInvitations.resourceId,
      resourceName: sharedResources.displayName,
      allowedClientIds: resourceInvitations.allowedClientIds,
      expiresAt: resourceInvitations.expiresAt,
      consumedAt: resourceInvitations.consumedAt,
      revokedAt: resourceInvitations.revokedAt,
      createdBy: resourceInvitations.createdBy,
      createdAt: resourceInvitations.createdAt,
    })
    .from(resourceInvitations)
    .innerJoin(
      subscriptionPlans,
      eq(resourceInvitations.planId, subscriptionPlans.id),
    )
    .leftJoin(
      sharedResources,
      eq(resourceInvitations.resourceId, sharedResources.id),
    )
    .where(eq(resourceInvitations.ownerApplicationId, ownerApplicationId))
    .orderBy(desc(resourceInvitations.createdAt));

  return rows.map((row) => ({
    ...row,
    state: resourceInvitationState(
      {
        ...row,
        tokenHash: "",
        ownerApplicationId,
      },
      now,
    ),
  }));
}
