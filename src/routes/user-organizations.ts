import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ORGANIZATION_SELF_SCOPE,
  RESOURCE_SELF_SCOPE,
} from "../compat/scopes.js";
import { ERR } from "../errors.js";
import { requireUserOrBearer } from "../middleware.js";
import {
  organizationNameSchema,
  teamFilterSchema,
} from "../services/organization-fields.js";
import {
  createTeam,
  issueInvitationToken,
  joinTeam,
  leaveTeam,
  listTeamMembers,
  revokeInvitationToken,
} from "../services/teams.js";
import { listUserOrganizations } from "../services/user-organizations.js";

const listQuerySchema = z.object({ team: teamFilterSchema.optional() });

const httpsLogoSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), {
    message: "The logo must be an https URL",
  });

const createTeamSchema = z
  .object({
    name: organizationNameSchema,
    logo: httpsLogoSchema.optional(),
  })
  .strict();

const joinTeamSchema = z.object({ token: z.string().min(1).max(256) }).strict();

export async function userOrganizationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // GET /api/user/organizations?team=true|false — organizations the caller belongs to
  fastify.get("/", async (req, reply) => {
    const userId = await requireUserOrBearer(req, reply, [
      ORGANIZATION_SELF_SCOPE,
      RESOURCE_SELF_SCOPE,
    ]);
    if (!userId) return;

    const query = listQuerySchema.safeParse(req.query);
    if (!query.success)
      throw ERR.ORG_003("Invalid organization filter", query.error.flatten());

    await reply.send({
      organizations: await listUserOrganizations(userId, query.data.team),
    });
  });

  // POST /api/user/organizations — create a team owned by the caller
  fastify.post("/", async (req, reply) => {
    const userId = await requireUserOrBearer(
      req,
      reply,
      ORGANIZATION_SELF_SCOPE,
    );
    if (!userId) return;

    const parsed = createTeamSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.ORG_003("Invalid team data", parsed.error.flatten());

    await reply.status(201).send({
      organization: await createTeam(userId, parsed.data),
    });
  });

  // POST /api/user/organizations/join — join a team with its invitation token
  fastify.post("/join", async (req, reply) => {
    const userId = await requireUserOrBearer(
      req,
      reply,
      ORGANIZATION_SELF_SCOPE,
    );
    if (!userId) return;

    const parsed = joinTeamSchema.safeParse(req.body);
    if (!parsed.success)
      throw ERR.ORG_003("Invalid invitation data", parsed.error.flatten());

    await reply.status(201).send({
      organization: await joinTeam(userId, parsed.data.token),
    });
  });

  // GET /api/user/organizations/:id/members — members of a team, visible to its members
  fastify.get<{ Params: { id: string } }>(
    "/:id/members",
    async (req, reply) => {
      const userId = await requireUserOrBearer(
        req,
        reply,
        ORGANIZATION_SELF_SCOPE,
      );
      if (!userId) return;

      await reply.send({
        members: await listTeamMembers(userId, req.params.id),
      });
    },
  );

  // POST /api/user/organizations/:id/leave — leave a team
  fastify.post<{ Params: { id: string } }>("/:id/leave", async (req, reply) => {
    const userId = await requireUserOrBearer(
      req,
      reply,
      ORGANIZATION_SELF_SCOPE,
    );
    if (!userId) return;

    await leaveTeam(userId, req.params.id);
    await reply.status(204).send();
  });

  // POST /api/user/organizations/:id/invitation-token — issue the team's invitation token
  fastify.post<{ Params: { id: string } }>(
    "/:id/invitation-token",
    async (req, reply) => {
      const userId = await requireUserOrBearer(
        req,
        reply,
        ORGANIZATION_SELF_SCOPE,
      );
      if (!userId) return;

      const { token, expiresAt } = await issueInvitationToken(
        userId,
        req.params.id,
      );
      await reply.status(201).send({ token, expiresAt });
    },
  );

  // DELETE /api/user/organizations/:id/invitation-token — revoke the team's invitation token
  fastify.delete<{ Params: { id: string } }>(
    "/:id/invitation-token",
    async (req, reply) => {
      const userId = await requireUserOrBearer(
        req,
        reply,
        ORGANIZATION_SELF_SCOPE,
      );
      if (!userId) return;

      await revokeInvitationToken(userId, req.params.id);
      await reply.status(204).send();
    },
  );
}
