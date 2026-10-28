import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import {
  subscriptionPlans,
  subscriptionPlanPrices,
  userSubscriptions,
} from "../../db/schema.js";
import { and, eq, ne, count, inArray } from "drizzle-orm";
import { ERR } from "../../errors.js";
import {
  archivePlanPrice,
  archivePlanProduct,
  deactivateMeterIfUnused,
  provisionPlanProduct,
  updatePlanProduct,
} from "../../services/billing/catalog.js";
import { setUserSubscription } from "../../services/subscriptions.js";
import { getActorUserId, requireAdmin } from "../../middleware.js";
import { subscriptionReasonSchema } from "./subscription-request.js";
import { createPlanSchema, ensureApp } from "./plan-shared.js";
import {
  ensurePlanTeamBeforeSave,
  retirePlanTeam,
  retireRenamedPlanTeam,
} from "../../services/litellm-sync.js";
import { planSlugConflict } from "../../services/litellm-plan.js";

const assignSubscriptionSchema = z.object({
  planId: z.string().uuid(),
  expiresAt: z.string().datetime().optional().nullable(),
  reason: subscriptionReasonSchema.optional(),
});

export async function plansRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

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
      const app = await ensureApp(req.params.appId);
      const parsed = createPlanSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid plan data", parsed.error.flatten());

      // The gateway team (and its access group) is named after the plan's slug,
      // so two plans of one application must not slugify to the same name.
      if (await planSlugConflict(app.id, parsed.data.name))
        throw ERR.APP_001("A plan with a similar name already exists", {
          field: "name",
        });

      // The plan's gateway team must exist before the plan can grant access.
      await ensurePlanTeamBeforeSave(app.id, parsed.data.name);

      // The operator never opens the Stripe dashboard: the Product is created here.
      const stripeProductId = await provisionPlanProduct({
        applicationId: app.id,
        appName: app.name,
        planName: parsed.data.name,
        description: parsed.data.description ?? null,
      });

      const [plan] = await db.transaction(async (tx) => {
        // Ensure only one default plan per app
        if (parsed.data.isDefault) {
          await tx
            .update(subscriptionPlans)
            .set({ isDefault: false })
            .where(eq(subscriptionPlans.applicationId, app.id));
        }
        return tx
          .insert(subscriptionPlans)
          .values({
            applicationId: app.id,
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

      const [before] = await db
        .select({ name: subscriptionPlans.name })
        .from(subscriptionPlans)
        .where(
          and(
            eq(subscriptionPlans.id, req.params.planId),
            eq(subscriptionPlans.applicationId, req.params.appId),
          ),
        )
        .limit(1);
      if (!before) throw ERR.SUB_001();

      // A renamed plan is a different plan as far as the gateway is concerned:
      // its new team must exist before the rename, and the old one is retired after.
      const renamedTo =
        parsed.data.name && parsed.data.name !== before.name
          ? parsed.data.name
          : null;
      if (renamedTo) {
        if (
          await planSlugConflict(req.params.appId, renamedTo, req.params.planId)
        )
          throw ERR.APP_001("A plan with a similar name already exists", {
            field: "name",
          });
        await ensurePlanTeamBeforeSave(req.params.appId, renamedTo);
      }

      const [plan] = await db.transaction(async (tx) => {
        // Ensure only one default plan per app
        if (parsed.data.isDefault) {
          await tx
            .update(subscriptionPlans)
            .set({ isDefault: false })
            .where(
              and(
                eq(subscriptionPlans.applicationId, req.params.appId),
                ne(subscriptionPlans.id, req.params.planId),
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

      if (renamedTo)
        await retireRenamedPlanTeam(req.params.appId, before.name, renamedTo);

      // Keep the Stripe Product name/description aligned with the plan row.
      if (plan.stripeProductId) {
        const app = await ensureApp(req.params.appId);
        await updatePlanProduct({
          stripeProductId: plan.stripeProductId,
          applicationId: app.id,
          appName: app.name,
          planName: plan.name,
          description: plan.description,
        });
      }

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

      const [plan] = await db
        .select({
          name: subscriptionPlans.name,
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

      const prices = await db
        .select({
          stripePriceId: subscriptionPlanPrices.stripePriceId,
          stripeMeterId: subscriptionPlanPrices.stripeMeterId,
          featureKey: subscriptionPlanPrices.featureKey,
        })
        .from(subscriptionPlanPrices)
        .where(eq(subscriptionPlanPrices.planId, req.params.planId));

      await db.transaction(async (tx) => {
        // Inactive subscriptions still reference the plan through a RESTRICT FK;
        // remove them so the plan can go. Active ones were rejected above.
        await tx
          .delete(userSubscriptions)
          .where(eq(userSubscriptions.planId, req.params.planId));
        await tx
          .delete(subscriptionPlans)
          .where(
            and(
              eq(subscriptionPlans.id, req.params.planId),
              eq(subscriptionPlans.applicationId, req.params.appId),
            ),
          );
      });

      // Archive, never delete, the Stripe objects (prices/products are
      // immutable history).
      await archivePlanProduct(plan.stripeProductId);
      for (const price of prices) {
        await archivePlanPrice(price.stripePriceId);
        if (price.stripeMeterId && price.featureKey) {
          await deactivateMeterIfUnused({
            applicationId: req.params.appId,
            featureKey: price.featureKey,
            stripeMeterId: price.stripeMeterId,
          });
        }
      }

      await retirePlanTeam(req.params.appId, plan.name);

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

      // Assign-only semantics: changing an existing plan goes through
      // `PATCH /applications/:id/users/:userId`, which requires a reason.
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

      await setUserSubscription({
        userId: req.params.userId,
        applicationId: req.params.appId,
        planId: parsed.data.planId,
        source: "admin",
        actorUserId: await getActorUserId(req),
        reason: parsed.data.reason ?? null,
        expiresAt: parsed.data.expiresAt
          ? new Date(parsed.data.expiresAt)
          : null,
      });

      await reply.status(201).send({ ok: true });
    },
  );

  // DELETE /api/admin/applications/:appId/users/:userId/subscription
  fastify.delete<{ Params: { appId: string; userId: string } }>(
    "/applications/:appId/users/:userId/subscription",
    async (req, reply) => {
      const [existing] = await db
        .select({ id: userSubscriptions.id })
        .from(userSubscriptions)
        .where(
          and(
            eq(userSubscriptions.userId, req.params.userId),
            eq(userSubscriptions.applicationId, req.params.appId),
          ),
        )
        .limit(1);
      if (!existing) throw ERR.SUB_001();

      await setUserSubscription({
        userId: req.params.userId,
        applicationId: req.params.appId,
        planId: null,
        source: "admin",
        actorUserId: await getActorUserId(req),
      });

      await reply.status(204).send();
    },
  );
}
