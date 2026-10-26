import { APIError } from "better-auth";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { invitation } from "../db/auth-schema.js";
import { registrationInvitations } from "../db/schema.js";
import type { InvitationFlow } from "./invitation-cookie.js";

/**
 * Resolve the address an invitation flow was issued for. The signed flow only
 * carries the identifiers: the authoritative address is always read from the
 * invitation row, so revoking or expiring an invitation also disables a
 * provider round-trip that was already in progress.
 */
async function flowEmail(flow: InvitationFlow): Promise<string | null> {
  if (flow.kind === "organization") {
    const [row] = await db
      .select({ email: invitation.email })
      .from(invitation)
      .where(
        and(
          eq(invitation.id, flow.invitationId),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row?.email.trim().toLowerCase() ?? null;
  }

  const [row] = await db
    .select({
      email: registrationInvitations.email,
      consumedAt: registrationInvitations.consumedAt,
      revokedAt: registrationInvitations.revokedAt,
    })
    .from(registrationInvitations)
    .where(
      and(
        eq(registrationInvitations.id, flow.invitationId),
        gt(registrationInvitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row || row.consumedAt || row.revokedAt) return null;
  const email = row.email.trim().toLowerCase();
  return email === flow.email ? email : null;
}

/** Whether this flow may create a new account during a social sign-in. */
export async function invitationFlowAllowsSignUp(
  flow: InvitationFlow,
): Promise<boolean> {
  return (await flowEmail(flow)) !== null;
}

/**
 * Enforce that the account being created by a social provider belongs to the
 * invited address. Called from `databaseHooks.user.create.before`; throwing an
 * APIError aborts the callback before any user or account row is written.
 */
export async function assertInvitationFlowEmail(
  flow: InvitationFlow,
  email: string,
): Promise<void> {
  const invitedEmail = await flowEmail(flow);
  if (!invitedEmail) {
    throw new APIError("FORBIDDEN", {
      code: "INVITATION_INVALID",
      message: "This invitation is no longer valid.",
    });
  }
  if (email.trim().toLowerCase() !== invitedEmail) {
    throw new APIError("FORBIDDEN", {
      code: "INVITATION_EMAIL_MISMATCH",
      message:
        "This invitation was issued for a different email address. Sign in with the invited address instead.",
    });
  }
}
