import type { FastifyInstance, FastifyRequest } from "fastify";
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
import { getRequestSession, requireAdmin } from "../middleware.js";
import { verifyBearerAccessToken } from "../services/oauth-tokens.js";

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

const userAppParamsSchema = z.object({
  userId: z.string().min(1),
  applicationId: z.string().uuid(),
});

const userAppKeyParamsSchema = userAppParamsSchema.extend({
  key: z.string().min(1).max(64).regex(CONSUMPTION_KEY_RE),
});

/**
 * Authenticate requests to the consumption endpoint.
 * Accepts both:
 * 1. An admin/superadmin BetterAuth session (dashboard callers — may act on any app).
 * 2. A `client_credentials` Bearer access token, bound to a single application
 *    (the token's `azp` claim holds the OAuth client id, which is the app slug).
 *
 * Bearer calls fail closed: an invalid or user-bound token is rejected rather
 * than silently downgraded to a session check. Machine callers are never
 * granted cross-application access.
 */
type ConsumptionCaller =
  { kind: "session" } | { kind: "machine"; appSlug: string };

async function requireConsumptionAuth(
  req: FastifyRequest,
): Promise<ConsumptionCaller> {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const verified = await verifyBearerAccessToken(token);
    if (!verified) {
      throw ERR.AUTH_001("Invalid or expired access token");
    }
    // Consumption reporting is a machine-to-machine operation: only a
    // client_credentials token (no bound user) is accepted.
    if (verified.userId) {
      throw ERR.CONS_004("Consumption requires a client_credentials token");
    }
    return { kind: "machine", appSlug: verified.clientId };
  }

  const session = await getRequestSession(req);
  if (session) {
    const role = (session.user as Record<string, unknown>).role as
      string | undefined;
    if (role === "admin" || role === "superadmin") return { kind: "session" };
  }

  throw ERR.CONS_004();
}

export async function consumptionRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // POST /api/consumption
  fastify.post("/", {}, async (req, reply) => {
    const caller = await requireConsumptionAuth(req);

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

    // When authenticated via Bearer token, verify the token belongs to this application.
    // This prevents a client from reporting consumption for a different application.
    if (caller.kind === "machine") {
      const [app] = await db
        .select({ slug: applications.slug })
        .from(applications)
        .where(eq(applications.id, applicationId))
        .limit(1);
      if (!app || app.slug !== caller.appSlug) {
        throw ERR.AUTH_011("Token is not authorized for this application");
      }
    }

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
  });

  // GET /api/consumption/:userId/:applicationId
  fastify.get<{ Params: { userId: string; applicationId: string } }>(
    "/:userId/:applicationId",
    {},
    async (req, reply) => {
      const caller = await requireConsumptionAuth(req);

      const parsed = userAppParamsSchema.safeParse(req.params);
      if (!parsed.success)
        throw ERR.CONS_005(
          "Invalid consumption identifier",
          parsed.error.flatten(),
        );

      // Enforce token-app binding for M2M token callers
      if (caller.kind === "machine") {
        const [app] = await db
          .select({ slug: applications.slug })
          .from(applications)
          .where(eq(applications.id, parsed.data.applicationId))
          .limit(1);
        if (!app || app.slug !== caller.appSlug) {
          throw ERR.AUTH_011("Token is not authorized for this application");
        }
      }

      const rows = await db
        .select({
          key: consumptionAggregates.key,
          total: consumptionAggregates.total,
          updatedAt: consumptionAggregates.updatedAt,
        })
        .from(consumptionAggregates)
        .where(
          and(
            eq(consumptionAggregates.userId, parsed.data.userId),
            eq(consumptionAggregates.applicationId, parsed.data.applicationId),
          ),
        );

      await reply.send({ aggregates: rows });
    },
  );

  // GET /api/consumption/:userId/:applicationId/:key
  fastify.get<{
    Params: { userId: string; applicationId: string; key: string };
  }>("/:userId/:applicationId/:key", {}, async (req, reply) => {
    const caller = await requireConsumptionAuth(req);

    const parsed = userAppKeyParamsSchema.safeParse(req.params);
    if (!parsed.success)
      throw ERR.CONS_005(
        "Invalid consumption identifier",
        parsed.error.flatten(),
      );

    // Enforce token-app binding for M2M token callers
    if (caller.kind === "machine") {
      const [app] = await db
        .select({ slug: applications.slug })
        .from(applications)
        .where(eq(applications.id, parsed.data.applicationId))
        .limit(1);
      if (!app || app.slug !== caller.appSlug) {
        throw ERR.AUTH_011("Token is not authorized for this application");
      }
    }

    const [row] = await db
      .select({
        key: consumptionAggregates.key,
        total: consumptionAggregates.total,
        updatedAt: consumptionAggregates.updatedAt,
      })
      .from(consumptionAggregates)
      .where(
        and(
          eq(consumptionAggregates.userId, parsed.data.userId),
          eq(consumptionAggregates.applicationId, parsed.data.applicationId),
          eq(consumptionAggregates.key, parsed.data.key),
        ),
      )
      .limit(1);

    if (!row) throw ERR.CONS_003("Consumption record not found");
    await reply.send({ aggregate: row });
  });

  // DELETE /api/consumption/:userId/:applicationId/:key (admin only)
  fastify.delete<{
    Params: { userId: string; applicationId: string; key: string };
  }>(
    "/:userId/:applicationId/:key",
    {
      preHandler: requireAdmin,
    },
    async (req, reply) => {
      const parsed = userAppKeyParamsSchema.safeParse(req.params);
      if (!parsed.success)
        throw ERR.CONS_005(
          "Invalid consumption identifier",
          parsed.error.flatten(),
        );
      await db
        .delete(consumptionAggregates)
        .where(
          and(
            eq(consumptionAggregates.userId, parsed.data.userId),
            eq(consumptionAggregates.applicationId, parsed.data.applicationId),
            eq(consumptionAggregates.key, parsed.data.key),
          ),
        );

      await db
        .delete(consumptionEntries)
        .where(
          and(
            eq(consumptionEntries.userId, parsed.data.userId),
            eq(consumptionEntries.applicationId, parsed.data.applicationId),
            eq(consumptionEntries.key, parsed.data.key),
          ),
        );

      await reply.status(204).send();
    },
  );
}
