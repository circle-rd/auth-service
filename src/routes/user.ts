import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  userApplications,
  applications,
  subscriptionPlans,
  subscriptionPlanPrices,
  consumptionAggregates,
} from "../db/schema.js";
import { session as sessionTable, user as userTable, member as memberTable, organization as organizationTable } from "../db/auth-schema.js";
import { and, eq, gt, inArray } from "drizzle-orm";
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

async function requireFullSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string; sessionId: string } | null> {
  const s = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!s) {
    await reply.status(401).send(ERR.AUTH_001().toJSON());
    return null;
  }
  return { userId: s.user.id, sessionId: s.session.id };
}

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  phone: z.string().max(30).nullable().optional(),
  company: z.string().max(100).nullable().optional(),
  position: z.string().max(100).nullable().optional(),
  address: z.string().max(200).nullable().optional(),
  image: z.string().url().nullable().optional(),
});

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

    // Fetch prices for all plans referenced by these subscriptions
    const planIds = rows
      .map((r) => r.subscriptionPlanId)
      .filter((id): id is string => id !== null);

    const pricesRows = planIds.length
      ? await db
          .select()
          .from(subscriptionPlanPrices)
          .where(inArray(subscriptionPlanPrices.planId, planIds))
      : [];

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
            prices: pricesRows
              .filter((p) => p.planId === r.subscriptionPlanId)
              .map((p) => ({
                id: p.id,
                planId: p.planId,
                name: p.name,
                amount: p.amount,
                currency: p.currency,
                interval: p.interval as "month" | "year" | "one_time",
                stripePriceId: p.stripePriceId,
                createdAt: p.createdAt.toISOString(),
              })),
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

  // GET /api/user/sessions
  // Returns the current user's active sessions.
  fastify.get("/sessions", async (req, reply) => {
    const ctx = await requireFullSession(req, reply);
    if (!ctx) return;

    const now = new Date();
    const sessions = await db
      .select({
        id: sessionTable.id,
        userId: sessionTable.userId,
        userAgent: sessionTable.userAgent,
        ipAddress: sessionTable.ipAddress,
        createdAt: sessionTable.createdAt,
        expiresAt: sessionTable.expiresAt,
      })
      .from(sessionTable)
      .where(
        and(
          eq(sessionTable.userId, ctx.userId),
          gt(sessionTable.expiresAt, now),
        ),
      )
      .orderBy(sessionTable.createdAt);

    await reply.send({ sessions, currentSessionId: ctx.sessionId });
  });

  // DELETE /api/user/sessions/:id
  // Revoke one of the current user's sessions (cannot revoke a foreign user's session).
  fastify.delete<{ Params: { id: string } }>(
    "/sessions/:id",
    async (req, reply) => {
      const ctx = await requireFullSession(req, reply);
      if (!ctx) return;

      // Verify the target session belongs to the current user
      const [target] = await db
        .select({ id: sessionTable.id, userId: sessionTable.userId })
        .from(sessionTable)
        .where(eq(sessionTable.id, req.params.id))
        .limit(1);

      if (!target || target.userId !== ctx.userId) {
        throw ERR.AUTH_001("Session not found");
      }

      await db
        .delete(sessionTable)
        .where(eq(sessionTable.id, req.params.id));

      await reply.status(204).send();
    },
  );

  // GET /api/user/organizations
  // Returns the organizations the current user is a member of.
  fastify.get("/organizations", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;

    const rows = await db
      .select({
        id: organizationTable.id,
        name: organizationTable.name,
        slug: organizationTable.slug,
        logo: organizationTable.logo,
        createdAt: organizationTable.createdAt,
        role: memberTable.role,
      })
      .from(memberTable)
      .innerJoin(organizationTable, eq(organizationTable.id, memberTable.organizationId))
      .where(eq(memberTable.userId, userId))
      .orderBy(organizationTable.name);

    await reply.send({ organizations: rows });
  });

  // PATCH /api/user/profile
  // Allows any authenticated user to update their own profile fields.
  fastify.patch("/profile", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;

    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ERR.USR_003("Invalid profile data", parsed.error.flatten());
    }

    const { name, phone, company, position, address, image } = parsed.data;

    await db
      .update(userTable)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(company !== undefined ? { company } : {}),
        ...(position !== undefined ? { position } : {}),
        ...(address !== undefined ? { address } : {}),
        ...(image !== undefined ? { image } : {}),
        updatedAt: new Date(),
      })
      .where(eq(userTable.id, userId));

    await reply.send({ ok: true });
  });
}
