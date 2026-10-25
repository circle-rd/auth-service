import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../middleware.js";
import { detectFavicon } from "../../services/favicon.js";

const querySchema = z.object({ url: z.string().max(2048) });

export async function applicationFaviconRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // GET /api/admin/applications/favicon?url=<page url>
  // Best effort: `iconUrl` is null whenever nothing usable was found, including
  // for an unreachable, private or malformed URL (the form calls this while typing).
  fastify.get(
    "/favicon",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { url } = querySchema.parse(req.query);
      await reply.send({ iconUrl: await detectFavicon(url) });
    },
  );
}
