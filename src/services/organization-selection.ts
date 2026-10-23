import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { member } from "../db/auth-schema.js";

export type OrganizationResolution = {
  /** Organization to bind the authorization to; undefined when the user has none. */
  organizationId: string | undefined;
  /** True when the user must pick one of several organizations. */
  selectionRequired: boolean;
};

/**
 * Decides which organization an authorization with the `org` scope runs under.
 * A user with no organization or a single one never has to choose: the sole
 * organization is used implicitly, whether or not it is the session's active one.
 */
export function resolveOrganization(
  organizationIds: readonly string[],
  activeOrganizationId: string | undefined,
): OrganizationResolution {
  const [first] = organizationIds;
  if (first === undefined) {
    return { organizationId: undefined, selectionRequired: false };
  }
  if (organizationIds.length === 1) {
    return { organizationId: first, selectionRequired: false };
  }
  const active =
    activeOrganizationId && organizationIds.includes(activeOrganizationId)
      ? activeOrganizationId
      : undefined;
  return { organizationId: active, selectionRequired: true };
}

export async function listUserOrganizationIds(
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  return rows.map((row) => row.organizationId);
}
