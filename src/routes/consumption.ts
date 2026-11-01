import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  consumptionEntries,
  consumptionAggregates,
  applications,
} from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { ERR } from "../errors.js";
import { getRequestSession, requireAdmin } from "../middleware.js";
import { verifyBearerAccessToken } from "../services/oauth-tokens.js";
import {
  consumptionKeySchema,
  consumptionReportSchema,
  getConsumption,
  listConsumption,
  parseConsumptionReport,
  recordConsumption,
  toReportResponse,
} from "../services/consumption.js";

const postConsumptionSchema = consumptionReportSchema.extend({
  applicationId: z.string().uuid(),
  userId: z.string().min(1),
});

const userAppParamsSchema = z.object({
  userId: z.string().min(1),
  applicationId: z.string().uuid(),
});

const userAppKeyParamsSchema = userAppParamsSchema.extend({
  key: consumptionKeySchema,
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

    const { userId, applicationId, key, value, idempotencyKey } =
      parseConsumptionReport(postConsumptionSchema, req.body);

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

    await reply.send(
      toReportResponse(
        await recordConsumption({
          userId,
          applicationId,
          key,
          value,
          idempotencyKey,
        }),
      ),
    );
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

      const rows = await listConsumption(
        parsed.data.userId,
        parsed.data.applicationId,
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

    const row = await getConsumption(
      parsed.data.userId,
      parsed.data.applicationId,
      parsed.data.key,
    );
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
      await db.transaction(async (tx) => {
        await tx
          .delete(consumptionAggregates)
          .where(
            and(
              eq(consumptionAggregates.userId, parsed.data.userId),
              eq(
                consumptionAggregates.applicationId,
                parsed.data.applicationId,
              ),
              eq(consumptionAggregates.key, parsed.data.key),
            ),
          );

        await tx
          .delete(consumptionEntries)
          .where(
            and(
              eq(consumptionEntries.userId, parsed.data.userId),
              eq(consumptionEntries.applicationId, parsed.data.applicationId),
              eq(consumptionEntries.key, parsed.data.key),
            ),
          );
      });

      await reply.status(204).send();
    },
  );
}
