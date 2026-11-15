import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { applications, userApplications } from "../../db/schema.js";
import { user as userTable } from "../../db/auth-schema.js";
import {
  resourceInvitations,
  resources as resourcesTable,
} from "../../db/resource-schema.js";
import { ERR } from "../../errors.js";
import { assignDefaultRoleIfNeeded } from "../claims.js";
import { publishEvent } from "../event-bus.js";
import { assignDefaultPlanIfNeeded } from "../subscriptions.js";
import { assertAppAdmin } from "./authority.js";
import { insertResourceGrant, type ResourceGrantRow } from "./grants.js";
import { getResource, type ResourceView } from "./registry.js";
import { isSchemeEnabledForApplication } from "./scheme-service.js";

export const RESOURCE_INVITATION_TTL_HOURS = 72;
export const RESOURCE_INVITATION_MAX_TTL_HOURS = 168;

export type ResourceInvitationRow = typeof resourceInvitations.$inferSelect;
export type ResourceInvitationState =
  "pending" | "consumed" | "revoked" | "expired";

export function toPublicResourceInvitation(invitation: ResourceInvitationRow) {
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
  invitation: ResourceInvitationRow,
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
  resourceId: string;
  actorUserId: string;
  ttlHours?: number;
}

export interface CreatedResourceInvitation {
  invitation: ResourceInvitationRow;
  token: string;
  resource: ResourceView;
}

/**
 * Invitations are for accounts that do not exist yet. An existing account must
 * be added to the resource application and receive a direct grant instead; the
 * registration-invitation service applies the same rule.
 */
export async function createResourceInvitation(
  input: CreateResourceInvitationInput,
): Promise<CreatedResourceInvitation> {
  const resource = await getResource(input.resourceId);
  await assertAppAdmin(input.actorUserId, resource.applicationId);

  const email = input.email.trim().toLowerCase();
  const [existing] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);
  if (existing) throw ERR.AUTH_013();

  const ttlHours = input.ttlHours ?? RESOURCE_INVITATION_TTL_HOURS;
  if (
    !Number.isInteger(ttlHours) ||
    ttlHours < 1 ||
    ttlHours > RESOURCE_INVITATION_MAX_TTL_HOURS
  ) {
    throw ERR.RES_001("Invalid invitation lifetime");
  }

  const token = randomBytes(32).toString("base64url");
  const [invitation] = await db
    .insert(resourceInvitations)
    .values({
      tokenHash: hashResourceInvitationToken(token),
      email,
      resourceId: resource.id,
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
      createdBy: input.actorUserId,
    })
    .returning();
  if (!invitation) {
    throw ERR.RES_001("Resource invitation could not be created");
  }
  return { invitation, token, resource };
}

export async function findResourceInvitationByToken(
  token: string,
): Promise<ResourceInvitationRow | null> {
  const [row] = await db
    .select()
    .from(resourceInvitations)
    .where(
      eq(resourceInvitations.tokenHash, hashResourceInvitationToken(token)),
    )
    .limit(1);
  return row ?? null;
}

export interface AcceptResourceInvitationInput {
  token: string;
  subjectId: string;
  email: string;
  emailVerified: boolean;
  now?: Date;
}

/**
 * A redeemed invitation is the authorisation to add the recipient to the
 * resource application and to create the user grant. Both rows and the
 * one-shot token are committed together; default role and plan are applied
 * after commit because they have their own event side effects.
 */
export async function acceptResourceInvitation(
  input: AcceptResourceInvitationInput,
): Promise<ResourceGrantRow> {
  const invitation = await findResourceInvitationByToken(input.token);
  if (!invitation) throw ERR.RES_010();
  const state = resourceInvitationState(invitation, input.now);
  if (state !== "pending") throw ERR.RES_010();
  if (
    invitation.email.trim().toLowerCase() !== input.email.trim().toLowerCase()
  ) {
    throw ERR.AUTH_014();
  }
  if (!input.emailVerified) throw ERR.AUTH_015();

  const resource = await getResource(invitation.resourceId);
  if (resource.status !== "validated") throw ERR.RES_004();
  const [app] = await db
    .select({ enabled: applications.resourceSharingEnabled })
    .from(applications)
    .where(eq(applications.id, resource.applicationId))
    .limit(1);
  if (!app?.enabled) throw ERR.RES_004();
  if (
    !(await isSchemeEnabledForApplication(
      resource.applicationId,
      resource.scheme,
    ))
  ) {
    throw ERR.RES_004();
  }

  const now = input.now ?? new Date();
  const result = await db.transaction(async (tx) => {
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

    const [membership] = await tx
      .select({ id: userApplications.id })
      .from(userApplications)
      .where(
        and(
          eq(userApplications.userId, input.subjectId),
          eq(userApplications.applicationId, resource.applicationId),
        ),
      )
      .limit(1);
    if (!membership) {
      await tx.insert(userApplications).values({
        userId: input.subjectId,
        applicationId: resource.applicationId,
        isActive: true,
      });
    } else {
      await tx
        .update(userApplications)
        .set({ isActive: true })
        .where(
          and(
            eq(userApplications.userId, input.subjectId),
            eq(userApplications.applicationId, resource.applicationId),
          ),
        );
    }

    const grant = await insertResourceGrant(
      {
        resourceId: resource.id,
        subjectType: "user",
        subjectId: input.subjectId,
        createdBy: invitation.createdBy,
      },
      tx,
    );
    return { grant, membershipCreated: !membership };
  });

  if (result.membershipCreated) {
    await assignDefaultRoleIfNeeded(input.subjectId, resource.applicationId);
    await assignDefaultPlanIfNeeded(input.subjectId, resource.applicationId);
    publishEvent("user.changed");
  }
  return result.grant;
}

export async function revokeResourceInvitation(
  id: string,
  actorUserId: string,
): Promise<ResourceInvitationRow> {
  const [invitation] = await db
    .select()
    .from(resourceInvitations)
    .where(eq(resourceInvitations.id, id))
    .limit(1);
  if (!invitation) throw ERR.RES_010();
  const resource = await getResource(invitation.resourceId);
  await assertAppAdmin(actorUserId, resource.applicationId);
  if (invitation.consumedAt || invitation.revokedAt) {
    throw ERR.RES_010();
  }
  const [row] = await db
    .update(resourceInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(resourceInvitations.id, id),
        isNull(resourceInvitations.consumedAt),
        isNull(resourceInvitations.revokedAt),
      ),
    )
    .returning();
  if (!row) throw ERR.RES_010();
  return row;
}

export interface OwnerResourceInvitationView {
  id: string;
  email: string;
  resourceId: string;
  resourceUri: string;
  resourceDisplayName: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  state: ResourceInvitationState;
}

export async function listResourceInvitationsForApplication(
  applicationId: string,
  now: Date = new Date(),
): Promise<OwnerResourceInvitationView[]> {
  const rows = await db
    .select({
      id: resourceInvitations.id,
      email: resourceInvitations.email,
      resourceId: resourceInvitations.resourceId,
      resourceUri: resourcesTable.uri,
      resourceDisplayName: resourcesTable.displayName,
      expiresAt: resourceInvitations.expiresAt,
      consumedAt: resourceInvitations.consumedAt,
      revokedAt: resourceInvitations.revokedAt,
      createdBy: resourceInvitations.createdBy,
      createdAt: resourceInvitations.createdAt,
    })
    .from(resourceInvitations)
    .innerJoin(
      resourcesTable,
      eq(resourceInvitations.resourceId, resourcesTable.id),
    )
    .where(eq(resourcesTable.applicationId, applicationId))
    .orderBy(desc(resourceInvitations.createdAt));

  return rows.map((row) => ({
    ...row,
    state: resourceInvitationState(
      {
        ...row,
        tokenHash: "",
      },
      now,
    ),
  }));
}
