import { createHash, randomBytes } from "node:crypto";
import { generateId } from "better-auth";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  member,
  organization,
  session as sessionTable,
  user as userTable,
} from "../db/auth-schema.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { teamInvitationTokens } from "../db/schema.js";
import { ERR } from "../errors.js";
import { ADMIN_ROOM, orgRoom, publishEvent, userRoom } from "./event-bus.js";

const INVITATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITATION_TOKEN_BYTES = 32;
const SLUG_MAX_LENGTH = 50;
const SLUG_SUFFIX_BYTES = 3;
const SLUG_ATTEMPTS = 3;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface TeamView {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  role: "owner" | "member";
  team: true;
  createdAt: Date;
}

export interface CreateTeamInput {
  name: string;
  logo?: string;
}

/**
 * The slug of a team: the normalised name followed by a random suffix, so two
 * teams with the same name never collide. Clients never choose it, which keeps
 * the slugs of companies out of reach of probing.
 */
export function deriveTeamSlug(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX_LENGTH - SLUG_SUFFIX_BYTES * 2 - 2)
    .replace(/-+$/, "");
  if (base === "") {
    throw ERR.ORG_003("The team name must contain a letter or a digit");
  }
  return `${base}-${randomBytes(SLUG_SUFFIX_BYTES).toString("hex")}`;
}

function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * Locks the team row, then checks that the caller owns it. Every operation that
 * changes who may act on a team goes through the lock, so two concurrent
 * requests cannot both pass the owner check.
 */
async function lockTeamForOwner(
  tx: DbTransaction,
  userId: string,
  organizationId: string,
): Promise<void> {
  const [team] = await tx
    .select({ team: organization.team })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .for("update");
  if (!team) throw ERR.ORG_001();
  if (!team.team) throw ERR.ORG_012();

  const [membership] = await tx
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);
  if (membership?.role !== "owner") {
    throw ERR.AUTH_011("Only a team owner can manage its invitation token");
  }
}

async function insertTeam(values: {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  userId: string;
  now: Date;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // The creator's row lock serialises concurrent creations, so the quota
    // cannot be overshot by parallel requests.
    const [creator] = await tx
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.id, values.userId))
      .for("update");
    if (!creator) throw ERR.USR_001();

    const [{ teams }] = await tx
      .select({ teams: count() })
      .from(organization)
      .where(
        and(
          eq(organization.createdBy, values.userId),
          eq(organization.team, true),
        ),
      );
    if (teams >= config.teams.maxPerUser) throw ERR.ORG_013();

    await tx.insert(organization).values({
      id: values.id,
      name: values.name,
      slug: values.slug,
      logo: values.logo,
      team: true,
      createdBy: values.userId,
      createdAt: values.now,
    });
    await tx.insert(member).values({
      id: generateId(),
      organizationId: values.id,
      userId: values.userId,
      role: "owner",
      createdAt: values.now,
    });
  });
}

export async function createTeam(
  userId: string,
  input: CreateTeamInput,
): Promise<TeamView> {
  const id = generateId();
  const now = new Date();
  const logo = input.logo ?? null;

  let slug = deriveTeamSlug(input.name);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await insertTeam({ id, name: input.name, slug, logo, userId, now });
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (attempt === SLUG_ATTEMPTS) {
        throw ERR.ORG_002("Could not generate a free slug for this team name");
      }
      slug = deriveTeamSlug(input.name);
    }
  }

  publishEvent("organization.changed", [
    ADMIN_ROOM,
    orgRoom(id),
    userRoom(userId),
  ]);
  return {
    id,
    name: input.name,
    slug,
    logo,
    role: "owner",
    team: true,
    createdAt: now,
  };
}

/**
 * Redeems an invitation token. An unknown, expired or revoked token, and a
 * token of a company, answer the same way so that a caller cannot tell them
 * apart.
 */
export async function joinTeam(
  userId: string,
  token: string,
): Promise<TeamView> {
  const now = new Date();
  const [target] = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo,
      createdAt: organization.createdAt,
    })
    .from(teamInvitationTokens)
    .innerJoin(
      organization,
      eq(organization.id, teamInvitationTokens.organizationId),
    )
    .where(
      and(
        eq(teamInvitationTokens.tokenHash, hashInvitationToken(token)),
        isNull(teamInvitationTokens.revokedAt),
        gt(teamInvitationTokens.expiresAt, now),
        eq(organization.team, true),
      ),
    )
    .limit(1);
  if (!target) throw ERR.ORG_014();

  const inserted = await db
    .insert(member)
    .values({
      id: generateId(),
      organizationId: target.id,
      userId,
      role: "member",
      createdAt: now,
    })
    .onConflictDoNothing({ target: [member.organizationId, member.userId] })
    .returning({ id: member.id });
  if (inserted.length === 0) throw ERR.ORG_005();

  publishEvent("organization.changed", [
    ADMIN_ROOM,
    orgRoom(target.id),
    userRoom(userId),
  ]);
  return { ...target, role: "member", team: true };
}

/**
 * Removes the caller from a team. The team is locked first, so two owners
 * leaving at the same time cannot both pass the last-owner check.
 */
export async function leaveTeam(
  userId: string,
  organizationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [team] = await tx
      .select({ team: organization.team })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .for("update");
    if (!team) throw ERR.ORG_001();
    if (!team.team) throw ERR.ORG_012();

    const [membership] = await tx
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, userId),
        ),
      )
      .limit(1);
    if (!membership) throw ERR.ORG_004();

    if (membership.role === "owner") {
      const [{ owners }] = await tx
        .select({ owners: count() })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.role, "owner"),
          ),
        );
      if (owners <= 1) throw ERR.ORG_011();
    }

    await tx
      .delete(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, userId),
        ),
      );
    await tx
      .update(sessionTable)
      .set({ activeOrganizationId: null })
      .where(
        and(
          eq(sessionTable.userId, userId),
          eq(sessionTable.activeOrganizationId, organizationId),
        ),
      );
  });

  publishEvent("organization.changed", [
    ADMIN_ROOM,
    orgRoom(organizationId),
    userRoom(userId),
  ]);
}

/**
 * Issues the team's invitation token, revoking the previous one. The plaintext
 * is returned once and never stored: only its hash is.
 */
export async function issueInvitationToken(
  userId: string,
  organizationId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TOKEN_TTL_MS);

  await db.transaction(async (tx) => {
    await lockTeamForOwner(tx, userId, organizationId);
    await tx
      .update(teamInvitationTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(teamInvitationTokens.organizationId, organizationId),
          isNull(teamInvitationTokens.revokedAt),
        ),
      );
    await tx.insert(teamInvitationTokens).values({
      organizationId,
      tokenHash: hashInvitationToken(token),
      createdBy: userId,
      expiresAt,
      createdAt: now,
    });
  });

  return { token, expiresAt };
}

export async function revokeInvitationToken(
  userId: string,
  organizationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockTeamForOwner(tx, userId, organizationId);
    await tx
      .update(teamInvitationTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(teamInvitationTokens.organizationId, organizationId),
          isNull(teamInvitationTokens.revokedAt),
        ),
      );
  });
}
