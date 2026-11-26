import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { userApplications } from "../../db/schema.js";
import { user as userTable } from "../../db/auth-schema.js";
import { ERR } from "../../errors.js";
import type { ResourceSubjectType } from "./types.js";

export type ResourceAudience =
  | { type: "everyone" }
  | { type: "plan"; planId: string }
  | { type: "organization"; organizationId: string }
  | { type: "user"; userId: string }
  | { type: "user"; email: string };

export interface ResolvedAudience {
  subjectType: ResourceSubjectType;
  subjectId: string | null;
}

/**
 * Maps the creation-time audience onto a grant subject. A recipient given by
 * e-mail must be an active member of the application; an unknown address and a
 * non-member get the same error, so the form cannot be used to probe which
 * accounts exist.
 */
export async function resolveAudience(
  audience: ResourceAudience,
  applicationId: string,
): Promise<ResolvedAudience> {
  switch (audience.type) {
    case "everyone":
      return { subjectType: "everyone", subjectId: null };
    case "plan":
      return { subjectType: "plan", subjectId: audience.planId };
    case "organization":
      return {
        subjectType: "organization",
        subjectId: audience.organizationId,
      };
    case "user":
      if ("userId" in audience) {
        return { subjectType: "user", subjectId: audience.userId };
      }
      return {
        subjectType: "user",
        subjectId: await activeMemberIdByEmail(audience.email, applicationId),
      };
  }
}

/**
 * Resolves an e-mail to any active account, for a personal resource. Access is
 * still gated by the membership of the application the recipient calls
 * through, so the recipient does not need a row in the owner's application.
 */
export async function userIdByEmail(email: string): Promise<string> {
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(sql`lower(${userTable.email})`, email.toLowerCase()))
    .limit(1);
  if (!row) {
    throw ERR.RES_001("The recipient was not found");
  }
  return row.id;
}

export async function activeMemberIdByEmail(
  email: string,
  applicationId: string,
): Promise<string> {
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .innerJoin(
      userApplications,
      and(
        eq(userApplications.userId, userTable.id),
        eq(userApplications.applicationId, applicationId),
        eq(userApplications.isActive, true),
      ),
    )
    .where(eq(sql`lower(${userTable.email})`, email.toLowerCase()))
    .limit(1);
  if (!row) {
    throw ERR.RES_001(
      "The recipient must be an active member of the application",
    );
  }
  return row.id;
}
