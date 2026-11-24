import { deleteGrantsNamingSubject } from "../../services/resources/resource-deletion.js";
import type { FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { ERR } from "../../errors.js";
import { auth } from "../../auth.js";
import { db } from "../../db/index.js";
import {
  organization,
  member,
  user as userTable,
} from "../../db/auth-schema.js";
import { count, ilike, or, eq, desc, asc, and } from "drizzle-orm";
import { requireAdmin } from "../../middleware.js";
import {
  ADMIN_ROOM,
  orgRoom,
  publishEvent,
  userRoom,
} from "../../services/event-bus.js";
import {
  domainVerificationRecord,
  newDomainVerificationToken,
  organizationDomainSchema,
  requestDomainVerification,
  verifyOrganizationDomain,
} from "../../services/organization-domains.js";
import {
  organizationNameSchema,
  organizationSlugSchema,
  teamFilterSchema,
} from "../../services/organization-fields.js";

const createOrgSchema = z.object({
  name: organizationNameSchema,
  slug: organizationSlugSchema,
  logo: z.string().url().optional(),
  domain: organizationDomainSchema.optional(),
  // Opt out of the DNS challenge when a domain is stored for display only.
  verifyDomain: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateOrgSchema = z
  .object({
    name: organizationNameSchema.optional(),
    slug: organizationSlugSchema.optional(),
    logo: z.string().url().nullable().optional(),
    domain: organizationDomainSchema.nullable().optional(),
    autoEnrollEnabled: z.boolean().optional(),
    // Persisted as the presence of a verification token: false clears the
    // challenge and any existing proof.
    verifyDomain: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "At least one field must be provided",
  });

const addMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["owner", "admin", "member"]).default("member"),
});

const createInvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "member"]).default("member"),
});

export async function organizationsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // GET /api/admin/organizations — list all organizations (Drizzle, paginated, searchable)
  fastify.get("/", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const page = Math.max(1, parseInt(q.page ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? "20", 10)));
    const search = q.search?.trim() || undefined;
    const sortBy =
      q.sortBy === "createdAt" || q.sortBy === "slug" ? q.sortBy : "name";
    const sortOrder = q.sortOrder === "desc" ? "desc" : "asc";
    const offset = (page - 1) * limit;

    const teamParam =
      q.team === undefined ? undefined : teamFilterSchema.safeParse(q.team);
    if (teamParam && !teamParam.success)
      throw ERR.ORG_003("Invalid team filter", teamParam.error.flatten());
    const teamFilter = teamParam?.success ? teamParam.data : undefined;

    const searchFilter = search
      ? or(
          ilike(organization.name, `%${search}%`),
          ilike(organization.slug, `%${search}%`),
          ilike(organization.domain, `%${search}%`),
        )
      : undefined;
    const listFilter = and(
      searchFilter,
      teamFilter === undefined ? undefined : eq(organization.team, teamFilter),
    );

    const orderCol =
      sortBy === "createdAt"
        ? organization.createdAt
        : sortBy === "slug"
          ? organization.slug
          : organization.name;
    const orderExpr = sortOrder === "desc" ? desc(orderCol) : asc(orderCol);

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          logo: organization.logo,
          domain: organization.domain,
          domainVerificationToken: organization.domainVerificationToken,
          autoEnrollEnabled: organization.autoEnrollEnabled,
          domainVerifiedAt: organization.domainVerifiedAt,
          domainLastCheckedAt: organization.domainLastCheckedAt,
          team: organization.team,
          createdAt: organization.createdAt,
          metadata: organization.metadata,
          memberCount: count(member.id),
        })
        .from(organization)
        .leftJoin(member, eq(member.organizationId, organization.id))
        .where(listFilter)
        .groupBy(organization.id)
        .orderBy(orderExpr)
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(organization).where(listFilter),
    ]);

    await reply.send({ organizations: rows, total, page, limit });
  });

  // POST /api/admin/organizations — create an organization (server-side, admin only)
  fastify.post("/", async (req, reply) => {
    const parsed = createOrgSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.ORG_003("Invalid organization data", parsed.error.flatten());

    const { name, slug, logo, domain, metadata, verifyDomain } = parsed.data;

    try {
      const created = await auth.api.createOrganization({
        body: {
          name,
          slug,
          ...(logo ? { logo } : {}),
          ...(domain ? { domain } : {}),
          ...(metadata ? { metadata } : {}),
        },
        headers: fromNodeHeaders(req.headers),
      });
      // A declared domain starts unverified. Hand the administrator the TXT
      // challenge immediately so the create dialog can show it.
      const verification =
        domain && verifyDomain !== false
          ? await requestDomainVerification(created.id)
          : null;
      await reply.status(201).send({
        organization: verification?.organization ?? created,
        ...(verification
          ? {
              domainVerification: {
                recordName: verification.recordName,
                recordValue: verification.recordValue,
              },
            }
          : {}),
      });
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : "Failed to create organization";
      if (msg.toLowerCase().includes("slug")) throw ERR.ORG_002(msg);
      throw ERR.ORG_003(msg);
    }
  });

  // GET /api/admin/organizations/:id — get a single organization
  fastify.get("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const org = await auth.api.getFullOrganization({
        query: { organizationId: id },
        headers: fromNodeHeaders(req.headers),
      });
      if (!org) throw ERR.ORG_001();
      await reply.send({ organization: org });
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("not found"))
        throw ERR.ORG_001();
      throw e;
    }
  });

  // DELETE /api/admin/organizations/:id — delete an organization
  fastify.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (existing.length === 0) throw ERR.ORG_001();
    await db.transaction(async (tx) => {
      await tx.delete(organization).where(eq(organization.id, id));
      await deleteGrantsNamingSubject("organization", id, tx);
    });
    publishEvent("organization.changed", [ADMIN_ROOM, orgRoom(id)]);
    await reply.status(204).send();
  });

  // PATCH /api/admin/organizations/:id — update an organization
  fastify.patch("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateOrgSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.ORG_003("Invalid organization data", parsed.error.flatten());

    const existing = await db
      .select({
        id: organization.id,
        domain: organization.domain,
        domainVerificationToken: organization.domainVerificationToken,
        domainVerifiedAt: organization.domainVerifiedAt,
      })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1);
    if (existing.length === 0) throw ERR.ORG_001();

    const data = parsed.data;
    if (data.slug) {
      const conflict = await db
        .select({ id: organization.id })
        .from(organization)
        .where(and(eq(organization.slug, data.slug)))
        .limit(1);
      if (conflict.length > 0 && conflict[0].id !== id) throw ERR.ORG_002();
    }

    const current = existing[0];
    const domainChanged =
      data.domain !== undefined && data.domain !== current.domain;

    if (data.autoEnrollEnabled === true) {
      if (
        domainChanged ||
        data.verifyDomain === false ||
        !current.domain ||
        !current.domainVerifiedAt
      ) {
        throw ERR.ORG_009("Verify the domain before enabling auto-enrollment");
      }
    }

    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.slug !== undefined) updates.slug = data.slug;
    if (data.logo !== undefined) updates.logo = data.logo;
    if (data.metadata !== undefined)
      updates.metadata = JSON.stringify(data.metadata);
    if (data.autoEnrollEnabled !== undefined)
      updates.autoEnrollEnabled = data.autoEnrollEnabled;

    let verification: {
      recordName: string;
      recordValue: string;
    } | null = null;
    if (domainChanged) updates.domain = data.domain;

    const targetDomain =
      data.domain !== undefined ? data.domain : current.domain;
    const issueChallenge =
      !!targetDomain &&
      data.verifyDomain !== false &&
      (domainChanged ||
        (data.verifyDomain === true &&
          !current.domainVerificationToken &&
          !current.domainVerifiedAt));

    if (domainChanged || data.verifyDomain === false || issueChallenge) {
      // A new challenge, a disabled verification or a different domain all
      // invalidate the previous proof and every membership it granted.
      const token = issueChallenge ? newDomainVerificationToken() : null;
      updates.domainVerificationToken = token;
      updates.domainVerifiedAt = null;
      updates.domainVerifiedBy = null;
      updates.domainLastCheckedAt = null;
      updates.autoEnrollEnabled = false;
      if (targetDomain && token) {
        const record = domainVerificationRecord(targetDomain, token);
        verification = {
          recordName: record.name,
          recordValue: record.value,
        };
      }
    }

    const [updated] = await db
      .update(organization)
      .set(updates)
      .where(eq(organization.id, id))
      .returning();

    publishEvent("organization.changed", [ADMIN_ROOM, orgRoom(id)]);

    await reply.send({
      organization: {
        ...updated,
        metadata:
          updated.metadata && typeof updated.metadata === "string"
            ? JSON.parse(updated.metadata)
            : updated.metadata,
      },
      ...(verification ? { domainVerification: verification } : {}),
    });
  });

  // POST /api/admin/organizations/:id/domain/verification — issue a new TXT challenge
  fastify.post("/:id/domain/verification", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await requestDomainVerification(id);
    await reply.send({
      organization: result.organization,
      domainVerification: {
        recordName: result.recordName,
        recordValue: result.recordValue,
      },
    });
  });

  // POST /api/admin/organizations/:id/domain/verify — check the published TXT record
  fastify.post("/:id/domain/verify", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) throw ERR.AUTH_001();
    const updated = await verifyOrganizationDomain(id, session.user.id);
    await reply.send({ organization: updated });
  });

  // GET /api/admin/organizations/:id/members — list members with embedded user data
  fastify.get("/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? "50", 10)));
    const offset = Math.max(0, parseInt(q.offset ?? "0", 10));
    const search = q.search?.trim() || undefined;

    const searchFilter = search
      ? or(
          ilike(userTable.name, `%${search}%`),
          ilike(userTable.email, `%${search}%`),
        )
      : undefined;

    const where = and(eq(member.organizationId, id), searchFilter);

    const [{ total }] = await db
      .select({ total: count() })
      .from(member)
      .innerJoin(userTable, eq(userTable.id, member.userId))
      .where(where);

    const rows = await db
      .select({
        id: member.id,
        organizationId: member.organizationId,
        userId: member.userId,
        role: member.role,
        createdAt: member.createdAt,
        user: {
          id: userTable.id,
          name: userTable.name,
          email: userTable.email,
          image: userTable.image,
        },
      })
      .from(member)
      .innerJoin(userTable, eq(userTable.id, member.userId))
      .where(where)
      .orderBy(asc(userTable.name))
      .limit(limit)
      .offset(offset);

    await reply.send({ members: rows, total });
  });

  // POST /api/admin/organizations/:id/members — add a member directly (no invite)
  fastify.post("/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = addMemberSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.ORG_003("Invalid member data", parsed.error.flatten());

    const { userId, role } = parsed.data;
    try {
      const member = await auth.api.addMember({
        body: { userId, role, organizationId: id },
        headers: fromNodeHeaders(req.headers),
      });
      await reply.status(201).send({ member });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to add member";
      if (msg.toLowerCase().includes("already")) throw ERR.ORG_005(msg);
      throw ERR.ORG_003(msg);
    }
  });

  // DELETE /api/admin/organizations/:id/members/:userId — remove a member
  fastify.delete("/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const existing = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, id), eq(member.userId, userId)))
      .limit(1);
    if (existing.length === 0) throw ERR.ORG_004();
    await db
      .delete(member)
      .where(and(eq(member.organizationId, id), eq(member.userId, userId)));
    publishEvent("organization.changed", [
      ADMIN_ROOM,
      orgRoom(id),
      userRoom(userId),
    ]);
    await reply.status(204).send();
  });

  // PATCH /api/admin/organizations/:id/members/:memberId/role — update member role
  fastify.patch("/:id/members/:memberId/role", async (req, reply) => {
    const { id, memberId } = req.params as { id: string; memberId: string };
    const parsed = z
      .object({ role: z.enum(["owner", "admin", "member"]) })
      .safeParse(req.body);
    if (!parsed.success)
      throw ERR.ORG_003("Invalid role", parsed.error.flatten());

    try {
      await auth.api.updateMemberRole({
        body: { memberId, role: parsed.data.role, organizationId: id },
        headers: fromNodeHeaders(req.headers),
      });
      await reply.status(204).send();
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : "Failed to update member role";
      throw ERR.ORG_004(msg);
    }
  });

  // GET /api/admin/organizations/:id/invitations — list invitations
  fastify.get("/:id/invitations", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const org = await auth.api.getFullOrganization({
        query: { organizationId: id },
        headers: fromNodeHeaders(req.headers),
      });
      if (!org) throw ERR.ORG_001();
      await reply.send({
        invitations: (org as Record<string, unknown>).invitations ?? [],
      });
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("not found"))
        throw ERR.ORG_001();
      throw e;
    }
  });

  // POST /api/admin/organizations/:id/invitations — create an invitation
  fastify.post("/:id/invitations", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = createInvitationSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.ORG_003("Invalid invitation data", parsed.error.flatten());

    const { email, role } = parsed.data;
    try {
      const invitation = await auth.api.createInvitation({
        body: { email, role, organizationId: id },
        headers: fromNodeHeaders(req.headers),
      });
      await reply.status(201).send({ invitation });
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : "Failed to create invitation";
      throw ERR.ORG_003(msg);
    }
  });

  // DELETE /api/admin/organizations/:id/invitations/:invitationId — cancel an invitation
  fastify.delete("/:id/invitations/:invitationId", async (req, reply) => {
    const { invitationId } = req.params as { id: string; invitationId: string };
    try {
      await auth.api.cancelInvitation({
        body: { invitationId },
        headers: fromNodeHeaders(req.headers),
      });
      await reply.status(204).send();
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : "Failed to cancel invitation";
      throw ERR.ORG_003(msg);
    }
  });
}
