import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { ERR } from "../../errors.js";
import { auth } from "../../auth.js";

async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session) {
    await reply.status(401).send(ERR.AUTH_001().toJSON());
    return;
  }
  const role = (session.user as Record<string, unknown>).role as
    | string
    | undefined;
  if (role !== "admin" && role !== "superadmin") {
    await reply
      .status(403)
      .send(ERR.AUTH_001("Insufficient permissions").toJSON());
    return;
  }
}

const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  logo: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const addMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["owner", "admin", "member"]).default("member"),
});

const createInvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "member"]).default("member"),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export async function organizationsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // GET /api/admin/organizations — list all organizations
  fastify.get("/", async (req, reply) => {
    const organizations = await auth.api.listOrganizations({
      headers: fromNodeHeaders(req.headers),
    });
    await reply.send({ organizations: organizations ?? [] });
  });

  // POST /api/admin/organizations — create an organization (server-side, admin only)
  fastify.post("/", async (req, reply) => {
    const parsed = createOrgSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.ORG_003("Invalid organization data", parsed.error.flatten());

    const { name, slug, logo, metadata } = parsed.data;

    try {
      const org = await auth.api.createOrganization({
        body: {
          name,
          slug,
          ...(logo ? { logo } : {}),
          ...(metadata ? { metadata } : {}),
        },
        headers: fromNodeHeaders(req.headers),
      });
      await reply.status(201).send({ organization: org });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to create organization";
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
      if (e instanceof Error && e.message.includes("not found")) throw ERR.ORG_001();
      throw e;
    }
  });

  // DELETE /api/admin/organizations/:id — delete an organization
  fastify.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await auth.api.deleteOrganization({
        body: { organizationId: id },
        headers: fromNodeHeaders(req.headers),
      });
      await reply.status(204).send();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to delete organization";
      throw ERR.ORG_001(msg);
    }
  });

  // GET /api/admin/organizations/:id/members — list members
  fastify.get("/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as Record<string, string>;
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "50", 10)));
    const offset = Math.max(0, parseInt(query.offset ?? "0", 10));

    const members = await auth.api.listMembers({
      query: { organizationId: id, limit, offset },
      headers: fromNodeHeaders(req.headers),
    });
    await reply.send({ members: members ?? [] });
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
    try {
      await auth.api.removeMember({
        body: { memberIdOrEmail: userId, organizationId: id },
        headers: fromNodeHeaders(req.headers),
      });
      await reply.status(204).send();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to remove member";
      throw ERR.ORG_004(msg);
    }
  });

  // PATCH /api/admin/organizations/:id/members/:memberId/role — update member role
  fastify.patch("/:id/members/:memberId/role", async (req, reply) => {
    const { id, memberId } = req.params as { id: string; memberId: string };
    const parsed = z.object({ role: z.enum(["owner", "admin", "member"]) }).safeParse(req.body);
    if (!parsed.success)
      throw ERR.ORG_003("Invalid role", parsed.error.flatten());

    try {
      await auth.api.updateMemberRole({
        body: { memberId, role: parsed.data.role, organizationId: id },
        headers: fromNodeHeaders(req.headers),
      });
      await reply.status(204).send();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to update member role";
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
      await reply.send({ invitations: (org as Record<string, unknown>).invitations ?? [] });
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("not found")) throw ERR.ORG_001();
      throw e;
    }
  });

  // POST /api/admin/organizations/:id/invitations — create an invitation
  fastify.post("/:id/invitations", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = createInvitationSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.ORG_003("Invalid invitation data", parsed.error.flatten());

    const { email, role, expiresInDays } = parsed.data;
    try {
      const invitation = await auth.api.createInvitation({
        body: { email, role, organizationId: id, expiresIn: expiresInDays * 24 * 60 * 60 },
        headers: fromNodeHeaders(req.headers),
      });
      await reply.status(201).send({ invitation });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to create invitation";
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
      const msg = e instanceof Error ? e.message : "Failed to cancel invitation";
      throw ERR.ORG_003(msg);
    }
  });
}
