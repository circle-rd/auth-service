import type { FastifyInstance } from "fastify";

const VERSION = process.env.npm_package_version ?? "0.1.0";

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/health", async (_req, reply) => {
    await reply.send({ status: "ok", version: VERSION });
  });
}
