/**
 * Registration invitations: an administrator grants one person the right to
 * create an account on one application while self-registration is closed.
 *
 * The emailed token is stored only as a SHA-256 hash and is single-use. The
 * account is created directly (not through the public sign-up endpoint, which
 * the registration policy blocks for these applications) with a verified
 * address, then granted application access — the administrator has vouched for
 * the person, and following the emailed link proves control of the address.
 */
import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  applications,
  registrationInvitations,
  userApplications,
} from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { ERR } from "../errors.js";
import { logger } from "../logger.js";
import { assignDefaultRoleIfNeeded } from "./claims.js";
import { insertCredentialUser, type DbExecutor } from "./credential-user.js";
import { publishEvent } from "./event-bus.js";
import { assignDefaultPlanIfNeeded } from "./subscriptions.js";

/** Invitation links are short-lived: long enough for an email, not a season. */
export const INVITATION_TTL_HOURS = 72;

/** Default and maximum page size for the admin invitation list. */
export const INVITATION_PAGE_DEFAULT = 25;
export const INVITATION_PAGE_MAX = 100;

export type RegistrationInvitation =
  typeof registrationInvitations.$inferSelect;

export type InvitationState = "pending" | "consumed" | "revoked" | "expired";

/** The stored row minus the token hash, which never leaves the service. */
export function toPublicInvitation(invitation: RegistrationInvitation) {
  const { tokenHash: _tokenHash, ...rest } = invitation;
  void _tokenHash;
  return rest;
}

export type PublicRegistrationInvitation = ReturnType<
  typeof toPublicInvitation
>;

/**
 * The single place that builds a redemption link, so the create and resend
 * paths can never disagree on the path or the query parameter names.
 */
export function buildInvitationUrl(
  applicationSlug: string,
  token: string,
): string {
  return `${config.betterAuth.url}/complete-registration?token=${encodeURIComponent(
    token,
  )}&client_id=${encodeURIComponent(applicationSlug)}`;
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function invitationState(
  invitation: RegistrationInvitation,
  now: Date = new Date(),
): InvitationState {
  if (invitation.revokedAt) return "revoked";
  if (invitation.consumedAt) return "consumed";
  if (invitation.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

export async function createRegistrationInvitation(
  opts: {
    email: string;
    applicationId: string;
    invitedByUserId: string;
    ttlHours?: number;
  },
  exec: DbExecutor = db,
): Promise<{
  invitation: RegistrationInvitation;
  token: string;
  applicationSlug: string;
}> {
  const [application] = await exec
    .select({ id: applications.id, slug: applications.slug })
    .from(applications)
    .where(eq(applications.id, opts.applicationId))
    .limit(1);
  if (!application) throw ERR.APP_002();

  const email = opts.email.trim().toLowerCase();
  // An existing account must not be handed a registration invitation: it would
  // never be redeemable. Grant that user application access instead.
  const [existing] = await exec
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);
  if (existing) throw ERR.AUTH_013();

  const token = randomBytes(32).toString("base64url");
  const ttlHours = opts.ttlHours ?? INVITATION_TTL_HOURS;
  const [invitation] = await exec
    .insert(registrationInvitations)
    .values({
      email,
      applicationId: application.id,
      tokenHash: hashInvitationToken(token),
      invitedByUserId: opts.invitedByUserId,
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
    })
    .returning();

  return { invitation, token, applicationSlug: application.slug };
}

export async function findRegistrationInvitationByToken(
  token: string,
): Promise<RegistrationInvitation | null> {
  const [invitation] = await db
    .select()
    .from(registrationInvitations)
    .where(eq(registrationInvitations.tokenHash, hashInvitationToken(token)))
    .limit(1);
  return invitation ?? null;
}

export async function getRegistrationInvitation(
  id: string,
): Promise<RegistrationInvitation | null> {
  const [invitation] = await db
    .select()
    .from(registrationInvitations)
    .where(eq(registrationInvitations.id, id))
    .limit(1);
  return invitation ?? null;
}

export async function listRegistrationInvitations(opts: {
  applicationId?: string;
  limit?: number;
  offset?: number;
}): Promise<RegistrationInvitation[]> {
  const limit = Math.min(
    Math.max(opts.limit ?? INVITATION_PAGE_DEFAULT, 1),
    INVITATION_PAGE_MAX,
  );
  const offset = Math.max(opts.offset ?? 0, 0);
  const filtered = opts.applicationId
    ? db
        .select()
        .from(registrationInvitations)
        .where(eq(registrationInvitations.applicationId, opts.applicationId))
    : db.select().from(registrationInvitations);
  return await filtered
    .orderBy(desc(registrationInvitations.createdAt))
    .limit(limit)
    .offset(offset);
}

/** Revoke a pending invitation. A consumed one is history and is left intact. */
export async function revokeRegistrationInvitation(
  id: string,
  exec: DbExecutor = db,
): Promise<RegistrationInvitation> {
  const [revoked] = await exec
    .update(registrationInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(registrationInvitations.id, id),
        isNull(registrationInvitations.consumedAt),
        isNull(registrationInvitations.revokedAt),
      ),
    )
    .returning();
  if (!revoked) throw ERR.AUTH_012("Invitation not found or already used");
  return revoked;
}

/**
 * Redeem an invitation: create the account, grant application access and mark
 * the invitation consumed. The consume and the creation share one transaction,
 * so a half-applied redemption cannot leave the token spent without an account.
 */
export async function completeRegistration(opts: {
  token: string;
  name: string;
  password: string;
}): Promise<{ userId: string; email: string; applicationId: string }> {
  const invitation = await findRegistrationInvitationByToken(opts.token);
  if (!invitation) throw ERR.AUTH_012();

  const state = invitationState(invitation);
  if (state === "expired") throw ERR.AUTH_012("This invitation has expired");
  if (state !== "pending") throw ERR.AUTH_012();

  const [existing] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, invitation.email))
    .limit(1);
  if (existing) throw ERR.AUTH_013();

  const storedPasswordHash = await hashPassword(opts.password);
  const now = new Date();

  const userId = await db.transaction(async (tx) => {
    // Conditional consume: only the transaction that flips the row from
    // pending may proceed, so two concurrent redemptions cannot both create.
    const [claimed] = await tx
      .update(registrationInvitations)
      .set({ consumedAt: now })
      .where(
        and(
          eq(registrationInvitations.id, invitation.id),
          isNull(registrationInvitations.consumedAt),
          isNull(registrationInvitations.revokedAt),
          gt(registrationInvitations.expiresAt, now),
        ),
      )
      .returning({ id: registrationInvitations.id });
    if (!claimed) throw ERR.AUTH_012();

    const { id } = await insertCredentialUser(tx, {
      name: opts.name,
      email: invitation.email,
      emailVerified: true,
      storedPasswordHash,
    });
    await tx
      .insert(userApplications)
      .values({
        userId: id,
        applicationId: invitation.applicationId,
        isActive: true,
      })
      .onConflictDoNothing();
    return id;
  });

  await assignDefaultRoleIfNeeded(userId, invitation.applicationId);
  await assignDefaultPlanIfNeeded(userId, invitation.applicationId);
  publishEvent("user.changed");
  logger.info(
    {
      userId,
      applicationId: invitation.applicationId,
      invitationId: invitation.id,
    },
    "[invitation] registration completed",
  );

  return {
    userId,
    email: invitation.email,
    applicationId: invitation.applicationId,
  };
}
