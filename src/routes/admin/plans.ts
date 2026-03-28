import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  applications,
  subscriptionPlans,
  subscriptionPlanPrices,
  userSubscriptions,
  userApplications,
} from "../../db/schema.js";
import { and, eq, count, inArray } from "drizzle-orm";
import { ERR } from "../../errors.js";
import { auth } from "../../auth.js";
import { stripe } from "../../services/stripe.js";

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

const createPlanSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional().nullable(),
  stripeProductId: z.string().optional().nullable(),
  features: z.record(z.unknown()).default({}),
  isDefault: z.boolean().default(false),
});

const createPlanPriceSchema = z.object({
  name: z.string().min(1).max(64),
  amount: z.number().int().positive(), // in smallest currency unit (e.g. cents)
  currency: z.string().length(3).default("usd"),
  interval: z.enum(["month", "year", "one_time"]).default("month"),
});

const assignSubscriptionSchema = z.object({
  planId: z.string().uuid(),
  expiresAt: z.string().datetime().optional().nullable(),
});

export async function plansRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  async function ensureApp(appId: string): Promise<void> {
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, appId))
      .limit(1);
    if (!app) throw ERR.APP_002();
  }

  // GET /api/admin/applications/:appId/plans
  fastify.get<{ Params: { appId: string } }>(
    "/applications/:appId/plans",
    async (req, reply) => {
      await ensureApp(req.params.appId);
      const plans = await db
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.applicationId, req.params.appId));

      const prices =
        plans.length > 0
          ? await db
              .select()
              .from(subscriptionPlanPrices)
              .where(
                inArray(
                  subscriptionPlanPrices.planId,
                  plans.map((p) => p.id),
                ),
              )
          : [];

      const pricesByPlan = new Map<string, typeof prices>();
      for (const price of prices) {
        const list = pricesByPlan.get(price.planId) ?? [];
        list.push(price);
        pricesByPlan.set(price.planId, list);
      }

      const plansWithPrices = plans.map((p) => ({
        ...p,
        prices: pricesByPlan.get(p.id) ?? [],
      }));

      await reply.send({ plans: plansWithPrices });
    },
  );

  // POST /api/admin/applications/:appId/plans
  fastify.post<{ Params: { appId: string } }>(
    "/applications/:appId/plans",
    async (req, reply) => {
      await ensureApp(req.params.appId);
      const parsed = createPlanSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid plan data", parsed.error.flatten());

      let stripeProductId = parsed.data.stripeProductId ?? null;

      // Create a Stripe Product if Stripe is configured and no product ID provided
      if (stripe && !stripeProductId) {
        const [app] = await db
          .select({ name: applications.name })
          .from(applications)
          .where(eq(applications.id, req.params.appId))
          .limit(1);

        const product = await stripe.products.create({
          name: `${app?.name ?? "App"} — ${parsed.data.name}`,
          metadata: {
            applicationId: req.params.appId,
            planName: parsed.data.name,
          },
        });
        stripeProductId = product.id;
      }

      const [plan] = await db.transaction(async (tx) => {
        // Ensure only one default plan per app
        if (parsed.data.isDefault) {
          await tx
            .update(subscriptionPlans)
            .set({ isDefault: false })
            .where(eq(subscriptionPlans.applicationId, req.params.appId));
        }
        return tx
          .insert(subscriptionPlans)
          .values({
            applicationId: req.params.appId,
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            stripeProductId,
            features: parsed.data.features,
            isDefault: parsed.data.isDefault,
          })
          .returning();
      });

      await reply.status(201).send({ plan: { ...plan, prices: [] } });
    },
  );

  // PATCH /api/admin/applications/:appId/plans/:planId
  fastify.patch<{ Params: { appId: string; planId: string } }>(
    "/applications/:appId/plans/:planId",
    async (req, reply) => {
      const parsed = createPlanSchema.partial().safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid plan data", parsed.error.flatten());

      const [plan] = await db.transaction(async (tx) => {
        // Ensure only one default plan per app
        if (parsed.data.isDefault) {
          await tx
            .update(subscriptionPlans)
            .set({ isDefault: false })
            .where(
              and(
                eq(subscriptionPlans.applicationId, req.params.appId),
                // Exclude the plan being updated so the next update sets it correctly
              ),
            );
        }
        return tx
          .update(subscriptionPlans)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(
            and(
              eq(subscriptionPlans.id, req.params.planId),
              eq(subscriptionPlans.applicationId, req.params.appId),
            ),
          )
          .returning();
      });
      if (!plan) throw ERR.SUB_001();

      await reply.send({ plan });
    },
  );

  // DELETE /api/admin/applications/:appId/plans/:planId
  fastify.delete<{ Params: { appId: string; planId: string } }>(
    "/applications/:appId/plans/:planId",
    async (req, reply) => {
      const [active] = await db
        .select({ cnt: count() })
        .from(userSubscriptions)
        .where(
          and(
            eq(userSubscriptions.planId, req.params.planId),
            eq(userSubscriptions.isActive, true),
          ),
        );
      if (active && Number(active.cnt) > 0) throw ERR.SUB_003();

      const [deleted] = await db
        .delete(subscriptionPlans)
        .where(
          and(
            eq(subscriptionPlans.id, req.params.planId),
            eq(subscriptionPlans.applicationId, req.params.appId),
          ),
        )
        .returning({ id: subscriptionPlans.id });
      if (!deleted) throw ERR.SUB_001();

      await reply.status(204).send();
    },
  );

  // ── Plan price tiers ───────────────────────────────────────────────────────

  // POST /api/admin/applications/:appId/plans/:planId/prices
  fastify.post<{ Params: { appId: string; planId: string } }>(
    "/applications/:appId/plans/:planId/prices",
    async (req, reply) => {
      const parsed = createPlanPriceSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid price data", parsed.error.flatten());

      // Ensure plan belongs to app
      const [plan] = await db
        .select({
          id: subscriptionPlans.id,
          stripeProductId: subscriptionPlans.stripeProductId,
        })
        .from(subscriptionPlans)
        .where(
          and(
            eq(subscriptionPlans.id, req.params.planId),
            eq(subscriptionPlans.applicationId, req.params.appId),
          ),
        )
        .limit(1);
      if (!plan) throw ERR.SUB_001();

      let stripePriceId: string | null = null;

      // Create Stripe Price if Stripe is configured and plan has a product
      if (stripe && plan.stripeProductId) {
        const stripePrice = await stripe.prices.create({
          product: plan.stripeProductId,
          unit_amount: parsed.data.amount,
          currency: parsed.data.currency,
          ...(parsed.data.interval === "one_time"
            ? {}
            : {
                recurring: {
                  interval: parsed.data.interval as "month" | "year",
                },
              }),
          nickname: parsed.data.name,
          metadata: { planId: req.params.planId },
        });
        stripePriceId = stripePrice.id;
      }

      const [price] = await db
        .insert(subscriptionPlanPrices)
        .values({
          planId: req.params.planId,
          name: parsed.data.name,
          amount: String(parsed.data.amount),
          currency: parsed.data.currency,
          interval: parsed.data.interval,
          stripePriceId,
        })
        .returning();

      await reply.status(201).send({ price });
    },
  );

  // DELETE /api/admin/applications/:appId/plans/:planId/prices/:priceId
  fastify.delete<{
    Params: { appId: string; planId: string; priceId: string };
  }>(
    "/applications/:appId/plans/:planId/prices/:priceId",
    async (req, reply) => {
      const [deleted] = await db
        .delete(subscriptionPlanPrices)
        .where(
          and(
            eq(subscriptionPlanPrices.id, req.params.priceId),
            eq(subscriptionPlanPrices.planId, req.params.planId),
          ),
        )
        .returning({
          id: subscriptionPlanPrices.id,
          stripePriceId: subscriptionPlanPrices.stripePriceId,
        });
      if (!deleted) throw ERR.SUB_001();

      // Archive Stripe price if configured (prices cannot be deleted in Stripe, only archived)
      if (stripe && deleted.stripePriceId) {
        await stripe.prices.update(deleted.stripePriceId, { active: false });
      }

      await reply.status(204).send();
    },
  );

  // ── User subscriptions ─────────────────────────────────────────────────────

  // POST /api/admin/applications/:appId/users/:userId/subscription
  fastify.post<{ Params: { appId: string; userId: string } }>(
    "/applications/:appId/users/:userId/subscription",
    async (req, reply) => {
      const parsed = assignSubscriptionSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid subscription data", parsed.error.flatten());

      // Ensure plan belongs to app
      const [plan] = await db
        .select({ id: subscriptionPlans.id })
        .from(subscriptionPlans)
        .where(
          and(
            eq(subscriptionPlans.id, parsed.data.planId),
            eq(subscriptionPlans.applicationId, req.params.appId),
          ),
        )
        .limit(1);
      if (!plan) throw ERR.SUB_001();

      // Check existing active subscription
      const [existing] = await db
        .select({ id: userSubscriptions.id })
        .from(userSubscriptions)
        .where(
          and(
            eq(userSubscriptions.userId, req.params.userId),
            eq(userSubscriptions.applicationId, req.params.appId),
            eq(userSubscriptions.isActive, true),
          ),
        )
        .limit(1);
      if (existing) throw ERR.SUB_002();

      const expiresAt = parsed.data.expiresAt
        ? new Date(parsed.data.expiresAt)
        : null;

      const [sub] = await db
        .insert(userSubscriptions)
        .values({
          userId: req.params.userId,
          applicationId: req.params.appId,
          planId: parsed.data.planId,
          expiresAt,
          isActive: true,
        })
        .returning();

      // Also update the subscriptionPlanId on userApplications for convenience
      await db
        .update(userApplications)
        .set({ subscriptionPlanId: parsed.data.planId })
        .where(
          and(
            eq(userApplications.userId, req.params.userId),
            eq(userApplications.applicationId, req.params.appId),
          ),
        );

      await reply.status(201).send({ subscription: sub });
    },
  );

  // DELETE /api/admin/applications/:appId/users/:userId/subscription
  fastify.delete<{ Params: { appId: string; userId: string } }>(
    "/applications/:appId/users/:userId/subscription",
    async (req, reply) => {
      const [deleted] = await db
        .delete(userSubscriptions)
        .where(
          and(
            eq(userSubscriptions.userId, req.params.userId),
            eq(userSubscriptions.applicationId, req.params.appId),
          ),
        )
        .returning({ id: userSubscriptions.id });
      if (!deleted) throw ERR.SUB_001();

      await db
        .update(userApplications)
        .set({ subscriptionPlanId: null })
        .where(
          and(
            eq(userApplications.userId, req.params.userId),
            eq(userApplications.applicationId, req.params.appId),
          ),
        );

      await reply.status(204).send();
    },
  );
}
