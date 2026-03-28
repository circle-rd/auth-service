import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { config } from "../../config.js";
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

export async function servicesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  /**
   * GET /api/admin/services
   * Returns whether optional integrations are configured via environment variables.
   * Only accessible to admin and superadmin users.
   */
  fastify.get("/", async (_req, reply) => {
    await reply.send({
      stripe: !!config.stripe.secretKey,
      providers: config.providers,
    });
  });
}
