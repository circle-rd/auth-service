import type { FastifyInstance } from "fastify";
import { db } from "../../db/index.js";
import {
  userApplications,
  consumptionAggregates,
  userSubscriptions,
} from "../../db/schema.js";
import { user as userTable } from "../../db/auth-schema.js";
import { and, eq } from "drizzle-orm";

export async function applicationBillingRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // GET /api/admin/applications/:id/subscriptions — compact rows used by the
  // financial tab. Keeping this separate from the paginated users table means
  // revenue KPIs do not depend on which page of users is visible.
  fastify.get<{ Params: { id: string } }>(
    "/:id/subscriptions",
    async (req, reply) => {
      const subscriptions = await db
        .select({
          userId: userSubscriptions.userId,
          planId: userSubscriptions.planId,
          isActive: userSubscriptions.isActive,
        })
        .from(userSubscriptions)
        .where(eq(userSubscriptions.applicationId, req.params.id));
      await reply.send({ subscriptions });
    },
  );

  // GET /api/admin/applications/:id/consumption — consumption aggregates for this app
  fastify.get<{ Params: { id: string } }>(
    "/:id/consumption",
    async (req, reply) => {
      const rows = await db
        .select({
          userId: consumptionAggregates.userId,
          userName: userTable.name,
          userEmail: userTable.email,
          subscriptionPlanId: userApplications.subscriptionPlanId,
          key: consumptionAggregates.key,
          total: consumptionAggregates.total,
          updatedAt: consumptionAggregates.updatedAt,
        })
        .from(consumptionAggregates)
        .leftJoin(userTable, eq(consumptionAggregates.userId, userTable.id))
        .leftJoin(
          userApplications,
          and(
            eq(userApplications.userId, consumptionAggregates.userId),
            eq(
              userApplications.applicationId,
              consumptionAggregates.applicationId,
            ),
          ),
        )
        .where(eq(consumptionAggregates.applicationId, req.params.id))
        .orderBy(consumptionAggregates.userId, consumptionAggregates.key);

      await reply.send({ entries: rows });
    },
  );
}
