import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { member, organization } from "../db/auth-schema.js";

export interface UserOrganization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: Date;
  domainVerifiedAt: Date | null;
  autoEnrollEnabled: boolean;
  role: string;
  team: boolean;
}

/** The organizations the user belongs to, optionally only teams or only non-teams. */
export async function listUserOrganizations(
  userId: string,
  team: boolean | undefined,
): Promise<UserOrganization[]> {
  return db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo,
      createdAt: organization.createdAt,
      domainVerifiedAt: organization.domainVerifiedAt,
      autoEnrollEnabled: organization.autoEnrollEnabled,
      role: member.role,
      team: organization.team,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(
        eq(member.userId, userId),
        team === undefined ? undefined : eq(organization.team, team),
      ),
    )
    .orderBy(organization.name);
}
