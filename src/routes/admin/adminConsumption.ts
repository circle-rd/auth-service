import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { db } from "../../db/index.js";
import { consumptionEntries, applications } from "../../db/schema.js";
import { and, eq, gte, lt, sql } from "drizzle-orm";
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
    await reply.status(403).send(ERR.AUTH_002().toJSON());
    return;
  }
}

const monthlyQuerySchema = z.object({
  year: z
    .string()
    .regex(/^\d{4}$/)
    .transform(Number)
    .optional(),
  month: z
    .string()
    .regex(/^(?:[1-9]|1[0-2])$/)
    .transform(Number)
    .optional(),
});

export async function adminConsumptionRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  /**
   * GET /api/admin/applications/:appId/consumption/monthly
   * Query params: year (default: current year), month (default: current month, 1-12)
   *
   * Returns aggregated consumptionEntries grouped by (userId, key)
   * for the requested calendar month.
   */
  fastify.get<{
    Params: { appId: string };
    Querystring: { year?: string; month?: string };
  }>("/applications/:appId/consumption/monthly", async (req, reply) => {
    const parsed = monthlyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw ERR.APP_001("Invalid query parameters", parsed.error.flatten());
    }

    const now = new Date();
    const year = parsed.data.year ?? now.getFullYear();
    const month = parsed.data.month ?? now.getMonth() + 1;

    // Validate appId references a real application
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, req.params.appId))
      .limit(1);
    if (!app) throw ERR.APP_002();

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 1);

    const rows = await db
      .select({
        userId: consumptionEntries.userId,
        key: consumptionEntries.key,
        total: sql<string>`SUM(${consumptionEntries.value})`,
      })
      .from(consumptionEntries)
      .where(
        and(
          eq(consumptionEntries.applicationId, req.params.appId),
          gte(consumptionEntries.recordedAt, startDate),
          lt(consumptionEntries.recordedAt, endDate),
        ),
      )
      .groupBy(consumptionEntries.userId, consumptionEntries.key);

    await reply.send({ entries: rows });
  });
}
