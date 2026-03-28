import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { db } from "../db/index.js";
import {
  userApplications,
  applications,
  subscriptionPlans,
  consumptionAggregates,
} from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { ERR } from "../errors.js";
import { auth } from "../auth.js";

async function requireSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session) {
    await reply.status(401).send(ERR.AUTH_001().toJSON());
    // Return a placeholder — Fastify will have already sent the response
    return "";
  }
  return session.user.id;
}

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/user/subscription
  // Returns the current user's app access list with plan details and features.
  fastify.get("/subscription", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;

    const rows = await db
      .select({
        applicationId: userApplications.applicationId,
        appName: applications.name,
        appSlug: applications.slug,
        appIcon: applications.icon,
        appIsActive: applications.isActive,
        userIsActive: userApplications.isActive,
        subscriptionPlanId: userApplications.subscriptionPlanId,
        planName: subscriptionPlans.name,
        planDescription: subscriptionPlans.description,
        planFeatures: subscriptionPlans.features,
        planIsDefault: subscriptionPlans.isDefault,
      })
      .from(userApplications)
      .innerJoin(
        applications,
        eq(userApplications.applicationId, applications.id),
      )
      .leftJoin(
        subscriptionPlans,
        eq(userApplications.subscriptionPlanId, subscriptionPlans.id),
      )
      .where(
        and(
          eq(userApplications.userId, userId),
          eq(userApplications.isActive, true),
        ),
      )
      .orderBy(applications.name);

    const subscriptions = rows.map((r) => ({
      applicationId: r.applicationId,
      applicationName: r.appName,
      applicationSlug: r.appSlug,
      applicationIcon: r.appIcon,
      isActive: r.userIsActive,
      plan: r.subscriptionPlanId
        ? {
            id: r.subscriptionPlanId,
            name: r.planName,
            description: r.planDescription,
            features: r.planFeatures ?? {},
            isDefault: r.planIsDefault,
          }
        : null,
    }));

    await reply.send({ subscriptions });
  });

  // GET /api/user/consumption/:appId
  // Returns the current user's consumption aggregates for a specific app.
  fastify.get<{ Params: { appId: string } }>(
    "/consumption/:appId",
    async (req, reply) => {
      const userId = await requireSession(req, reply);
      if (!userId) return;

      // Verify user has access to this app
      const [access] = await db
        .select({ id: userApplications.id })
        .from(userApplications)
        .where(
          and(
            eq(userApplications.userId, userId),
            eq(userApplications.applicationId, req.params.appId),
          ),
        )
        .limit(1);
      if (!access) throw ERR.APP_005();

      const aggregates = await db
        .select({
          key: consumptionAggregates.key,
          total: consumptionAggregates.total,
          updatedAt: consumptionAggregates.updatedAt,
        })
        .from(consumptionAggregates)
        .where(
          and(
            eq(consumptionAggregates.userId, userId),
            eq(consumptionAggregates.applicationId, req.params.appId),
          ),
        )
        .orderBy(consumptionAggregates.key);

      await reply.send({ aggregates });
    },
  );
}
