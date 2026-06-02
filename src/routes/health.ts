import type { FastifyInstance } from "fastify";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/health", async (_req, reply) => {
    await reply.send({ status: "ok", version });
  });
}
