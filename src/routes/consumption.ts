import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  consumptionEntries,
  consumptionAggregates,
  userApplications,
  applications,
} from "../db/schema.js";
import { and, eq, sql } from "drizzle-orm";
import { ERR } from "../errors.js";
import { auth } from "../auth.js";

const CONSUMPTION_KEY_RE = /^[a-zA-Z0-9.]+$/;

const postConsumptionSchema = z.object({
  applicationId: z.string().uuid(),
  userId: z.string().min(1),
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(CONSUMPTION_KEY_RE, "key must be alphanumeric with dots"),
  value: z.number().finite("value must be a finite number"),
});

/**
 * Authenticate requests to the consumption endpoint.
 * Accepts both:
 * 1. A valid BetterAuth session (admin users calling from frontend)
 * 2. A Bearer access token issued via client_credentials grant
 */
async function requireConsumptionAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith("Bearer ")) {
    // Let BetterAuth verify the access token
    const token = authHeader.slice(7);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BetterAuth API is dynamic
      const verified = await (auth.api as any).verifyAccessToken?.({ token });
      if (verified) return;
    } catch {
      // Fall through to session check
    }
  }

  // Check session (admin/superadmin)
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (session) {
    const role = (session.user as Record<string, unknown>).role as
      | string
      | undefined;
    if (role === "admin" || role === "superadmin") return;
  }

  await reply
    .status(401)
    .send(ERR.AUTH_001("Valid client_credentials token required").toJSON());
}

export async function consumptionRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // POST /api/consumption
  fastify.post(
    "/",
    { preHandler: requireConsumptionAuth },
    async (req, reply) => {
      const parsed = postConsumptionSchema.safeParse(req.body);
      if (!parsed.success) {
        const issues = parsed.error.issues;
        const keyIssue = issues.find((i) => i.path.includes("key"));
        const valueIssue = issues.find((i) => i.path.includes("value"));
        if (keyIssue) throw ERR.CONS_001(keyIssue.message);
        if (valueIssue) throw ERR.CONS_002(valueIssue.message);
        throw ERR.APP_001("Invalid consumption data", parsed.error.flatten());
      }

      const { userId, applicationId, key, value } = parsed.data;

      // Verify user ↔ app relationship exists
      const [access] = await db
        .select({ id: userApplications.id })
        .from(userApplications)
        .where(
          and(
            eq(userApplications.userId, userId),
            eq(userApplications.applicationId, applicationId),
          ),
        )
        .limit(1);
      if (!access) throw ERR.CONS_003();

      // Insert raw entry
      await db.insert(consumptionEntries).values({
        userId,
        applicationId,
        key,
        value: String(value),
      });

      // Upsert aggregate (increment total by value, supporting negative credits)
      await db
        .insert(consumptionAggregates)
        .values({
          userId,
          applicationId,
          key,
          total: String(value),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            consumptionAggregates.userId,
            consumptionAggregates.applicationId,
            consumptionAggregates.key,
          ],
          set: {
            total: sql`${consumptionAggregates.total} + ${String(value)}`,
            updatedAt: new Date(),
          },
        });

      // Re-query aggregate for response
      const [aggregate] = await db
        .select({
          key: consumptionAggregates.key,
          total: consumptionAggregates.total,
        })
        .from(consumptionAggregates)
        .where(
          and(
            eq(consumptionAggregates.userId, userId),
            eq(consumptionAggregates.applicationId, applicationId),
            eq(consumptionAggregates.key, key),
          ),
        )
        .limit(1);

      await reply.send({ success: true, aggregate });
    },
  );

  // GET /api/consumption/:userId/:applicationId
  fastify.get<{ Params: { userId: string; applicationId: string } }>(
    "/:userId/:applicationId",
    { preHandler: requireConsumptionAuth },
    async (req, reply) => {
      const rows = await db
        .select({
          key: consumptionAggregates.key,
          total: consumptionAggregates.total,
          updatedAt: consumptionAggregates.updatedAt,
        })
        .from(consumptionAggregates)
        .where(
          and(
            eq(consumptionAggregates.userId, req.params.userId),
            eq(consumptionAggregates.applicationId, req.params.applicationId),
          ),
        );

      await reply.send({ aggregates: rows });
    },
  );

  // GET /api/consumption/:userId/:applicationId/:key
  fastify.get<{
    Params: { userId: string; applicationId: string; key: string };
  }>(
    "/:userId/:applicationId/:key",
    { preHandler: requireConsumptionAuth },
    async (req, reply) => {
      const [row] = await db
        .select({
          key: consumptionAggregates.key,
          total: consumptionAggregates.total,
          updatedAt: consumptionAggregates.updatedAt,
        })
        .from(consumptionAggregates)
        .where(
          and(
            eq(consumptionAggregates.userId, req.params.userId),
            eq(consumptionAggregates.applicationId, req.params.applicationId),
            eq(consumptionAggregates.key, req.params.key),
          ),
        )
        .limit(1);

      if (!row) throw ERR.CONS_004();
      await reply.send({ aggregate: row });
    },
  );

  // DELETE /api/consumption/:userId/:applicationId/:key (admin only)
  fastify.delete<{
    Params: { userId: string; applicationId: string; key: string };
  }>(
    "/:userId/:applicationId/:key",
    {
      preHandler: async (req, reply) => {
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
        }
      },
    },
    async (req, reply) => {
      await db
        .delete(consumptionAggregates)
        .where(
          and(
            eq(consumptionAggregates.userId, req.params.userId),
            eq(consumptionAggregates.applicationId, req.params.applicationId),
            eq(consumptionAggregates.key, req.params.key),
          ),
        );

      await db
        .delete(consumptionEntries)
        .where(
          and(
            eq(consumptionEntries.userId, req.params.userId),
            eq(consumptionEntries.applicationId, req.params.applicationId),
            eq(consumptionEntries.key, req.params.key),
          ),
        );

      await reply.status(204).send();
    },
  );
}
