import { generateId } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  invitation,
  member,
  organization,
  user as userTable,
} from "../db/auth-schema.js";
import { ERR } from "../errors.js";
import { logger } from "../logger.js";
import { insertCredentialUser } from "./credential-user.js";
import { publishEvent } from "./event-bus.js";

export type OrganizationInvitationState = "pending" | "expired" | "invalid";

export interface OrganizationInvitationDetails {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date;
  organizationId: string;
  organizationName: string;
  inviterName: string | null;
  inviterEmail: string;
}

/**
 * The invitation details an invitee may see. The invitation id is the bearer
 * credential carried by the email link, so only the fields needed to render
 * the acceptance page are exposed.
 */
export async function findOrganizationInvitation(
  id: string,
): Promise<OrganizationInvitationDetails | null> {
  const [row] = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      organizationId: invitation.organizationId,
      organizationName: organization.name,
      inviterName: userTable.name,
      inviterEmail: userTable.email,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .innerJoin(userTable, eq(userTable.id, invitation.inviterId))
    .where(eq(invitation.id, id))
    .limit(1);
  return row ?? null;
}

export function organizationInvitationState(
  invitationRow: Pick<OrganizationInvitationDetails, "status" | "expiresAt">,
  now: Date = new Date(),
): OrganizationInvitationState {
  if (invitationRow.status !== "pending") return "invalid";
  if (invitationRow.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

export async function hasAccountWithEmail(email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email.trim().toLowerCase()))
    .limit(1);
  return row !== undefined;
}

/**
 * Create an account from an organization invitation, add it to the
 * organization and mark the invitation accepted in one transaction.
 *
 * This path deliberately creates the account directly instead of going through
 * `/api/auth/sign-up/email`: the invitation link already proves control of the
 * invited mailbox, while the public sign-up endpoint is closed for the
 * deployment. The account is created with a verified address for the same
 * reason.
 */
export async function completeOrganizationRegistration(opts: {
  invitationId: string;
  name: string;
  password: string;
}): Promise<{
  userId: string;
  email: string;
  organizationId: string;
}> {
  const invitationRow = await findOrganizationInvitation(opts.invitationId);
  if (!invitationRow) throw ERR.AUTH_012();

  const state = organizationInvitationState(invitationRow);
  if (state === "expired") throw ERR.AUTH_012("This invitation has expired");
  if (state !== "pending") throw ERR.AUTH_012();

  const email = invitationRow.email.trim().toLowerCase();
  if (await hasAccountWithEmail(email)) throw ERR.AUTH_013();

  const storedPasswordHash = await hashPassword(opts.password);
  const now = new Date();

  const userId = await db.transaction(async (tx) => {
    // Conditional claim: only one concurrent redemption can flip the row, so
    // two requests cannot both create an account for the same invitation.
    const [claimed] = await tx
      .update(invitation)
      .set({ status: "accepted" })
      .where(
        and(
          eq(invitation.id, invitationRow.id),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, now),
        ),
      )
      .returning({
        organizationId: invitation.organizationId,
        role: invitation.role,
      });
    if (!claimed) throw ERR.AUTH_012();

    const { id } = await insertCredentialUser(tx, {
      name: opts.name,
      email,
      emailVerified: true,
      storedPasswordHash,
    });
    await tx.insert(member).values({
      id: generateId(),
      organizationId: claimed.organizationId,
      userId: id,
      role: claimed.role ?? "member",
      createdAt: now,
    });
    return id;
  });

  publishEvent("organization.changed");
  publishEvent("user.changed");
  logger.info(
    {
      userId,
      organizationId: invitationRow.organizationId,
    },
    "[invitation] organization registration completed",
  );

  return {
    userId,
    email,
    organizationId: invitationRow.organizationId,
  };
}
