import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { db } from "../../db/index.js";
import { session as sessionTable } from "../../db/auth-schema.js";
import { gt, count } from "drizzle-orm";
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

export async function sessionsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // GET /api/admin/sessions
  fastify.get("/", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const page = Math.max(1, parseInt(query.page ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "20", 10)));
    const offset = (page - 1) * limit;
    const now = new Date();

    const [{ total }] = await db
      .select({ total: count() })
      .from(sessionTable)
      .where(gt(sessionTable.expiresAt, now));

    const list = await db
      .select({
        id: sessionTable.id,
        userId: sessionTable.userId,
        userAgent: sessionTable.userAgent,
        ipAddress: sessionTable.ipAddress,
        createdAt: sessionTable.createdAt,
        expiresAt: sessionTable.expiresAt,
      })
      .from(sessionTable)
      .where(gt(sessionTable.expiresAt, now))
      .limit(limit)
      .offset(offset);

    await reply.send({ total, list, page, limit });
  });
}
