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
 * 1. A valid BetterAuth session (admin users calling from frontend)
 * 2. A Bearer access token issued via client_credentials grant — bound to a
 *    specific application (the token's `sub` must match the app slug).
 *
 * Returns the application slug extracted from the Bearer token, or null when
 * authenticated via admin session (session-based callers can act on any app).
 */
async function requireConsumptionAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ tokenAppSlug: string | null }> {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BetterAuth API is dynamic
      const verified = await (auth.api as any).verifyAccessToken?.({ token });
      if (verified) {
        // Decode the JWT payload to extract the client identifier.
        // For client_credentials tokens, `sub` holds the OAuth client ID (= app slug).
        // We do NOT skip signature verification — verifyAccessToken already did it.
        const [, payloadB64] = token.split(".");
        const payload = payloadB64
          ? JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"))
          : null;
        // sub is set to the client_id for machine-to-machine tokens.
        const tokenAppSlug =
          payload && typeof payload.sub === "string" && !payload.sub.includes("@")
            ? (payload.sub as string)
            : null;
        return { tokenAppSlug };
      }
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
    if (role === "admin" || role === "superadmin") return { tokenAppSlug: null };
  }

  await reply.status(403).send(ERR.CONS_004().toJSON());
  return { tokenAppSlug: null }; // unreachable after send, satisfies TypeScript
}

export async function consumptionRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // POST /api/consumption
  fastify.post(
    "/",
    {},
    async (req, reply) => {
      const { tokenAppSlug } = await requireConsumptionAuth(req, reply);
      if (reply.sent) return;

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
      if (tokenAppSlug !== null) {
        const [app] = await db
          .select({ slug: applications.slug })
          .from(applications)
          .where(eq(applications.id, applicationId))
          .limit(1);
        if (!app || app.slug !== tokenAppSlug) {
          throw ERR.AUTH_001("Token is not authorized for this application");
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
    },
  );

  // GET /api/consumption/:userId/:applicationId
  fastify.get<{ Params: { userId: string; applicationId: string } }>(
    "/:userId/:applicationId",
    {},
    async (req, reply) => {
      const { tokenAppSlug } = await requireConsumptionAuth(req, reply);
      if (reply.sent) return;

      const parsed = userAppParamsSchema.safeParse(req.params);
      if (!parsed.success)
        throw ERR.CONS_005("Invalid consumption identifier", parsed.error.flatten());

      // Enforce token-app binding for M2M token callers
      if (tokenAppSlug !== null) {
        const [app] = await db
          .select({ slug: applications.slug })
          .from(applications)
          .where(eq(applications.id, parsed.data.applicationId))
          .limit(1);
        if (!app || app.slug !== tokenAppSlug) {
          throw ERR.AUTH_001("Token is not authorized for this application");
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
  }>(
    "/:userId/:applicationId/:key",
    {},
    async (req, reply) => {
      const { tokenAppSlug } = await requireConsumptionAuth(req, reply);
      if (reply.sent) return;

      const parsed = userAppKeyParamsSchema.safeParse(req.params);
      if (!parsed.success)
        throw ERR.CONS_005("Invalid consumption identifier", parsed.error.flatten());

      // Enforce token-app binding for M2M token callers
      if (tokenAppSlug !== null) {
        const [app] = await db
          .select({ slug: applications.slug })
          .from(applications)
          .where(eq(applications.id, parsed.data.applicationId))
          .limit(1);
        if (!app || app.slug !== tokenAppSlug) {
          throw ERR.AUTH_001("Token is not authorized for this application");
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
      const parsed = userAppKeyParamsSchema.safeParse(req.params);
      if (!parsed.success)
        throw ERR.CONS_005("Invalid consumption identifier", parsed.error.flatten());
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
