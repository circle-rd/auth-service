import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { subscriptionPlanPrices } from "../../db/schema.js";
import { ERR } from "../../errors.js";
import {
  archivePlanPrice,
  deactivateMeterIfUnused,
  provisionPlanPrice,
  updatePlanPriceNickname,
} from "../../services/billing/catalog.js";
import { requireAdmin } from "../../middleware.js";
import {
  createPlanPriceSchema,
  ensureApp,
  ensurePlan,
  updatePlanPriceSchema,
} from "./plan-shared.js";

export async function planPricesRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // POST /api/admin/applications/:appId/plans/:planId/prices
  fastify.post<{ Params: { appId: string; planId: string } }>(
    "/applications/:appId/plans/:planId/prices",
    async (req, reply) => {
      const parsed = createPlanPriceSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid price data", parsed.error.flatten());

      const app = await ensureApp(req.params.appId);
      const plan = await ensurePlan(req.params.appId, req.params.planId);

      const { billingType, featureKey } = parsed.data;
      if (billingType === "metered" && featureKey) {
        const [dupe] = await db
          .select({ id: subscriptionPlanPrices.id })
          .from(subscriptionPlanPrices)
          .where(
            and(
              eq(subscriptionPlanPrices.planId, req.params.planId),
              eq(subscriptionPlanPrices.featureKey, featureKey),
            ),
          )
          .limit(1);
        if (dupe)
          throw ERR.BIL_002(
            "This plan already has a metered price for that feature key",
          );
      }

      const provision = await provisionPlanPrice({
        applicationId: app.id,
        appSlug: app.slug,
        appName: app.name,
        stripeProductId: plan.stripeProductId,
        planId: req.params.planId,
        name: parsed.data.name,
        amount: parsed.data.amount,
        currency: parsed.data.currency,
        interval: parsed.data.interval,
        billingType,
        featureKey: featureKey ?? null,
      });

      const [price] = await db
        .insert(subscriptionPlanPrices)
        .values({
          planId: req.params.planId,
          name: parsed.data.name,
          amount: String(parsed.data.amount),
          currency: parsed.data.currency,
          interval: parsed.data.interval,
          billingType,
          featureKey: featureKey ?? null,
          unit: billingType === "metered" ? (parsed.data.unit ?? null) : null,
          usageLimit:
            billingType === "metered" ? (parsed.data.usageLimit ?? null) : null,
          stripePriceId: provision.stripePriceId,
          stripeMeterId: provision.stripeMeterId,
        })
        .returning();

      await reply.status(201).send({ price });
    },
  );

  // PATCH /api/admin/applications/:appId/plans/:planId/prices/:priceId
  fastify.patch<{
    Params: { appId: string; planId: string; priceId: string };
  }>(
    "/applications/:appId/plans/:planId/prices/:priceId",
    async (req, reply) => {
      await ensureApp(req.params.appId);
      await ensurePlan(req.params.appId, req.params.planId);

      const [price] = await db
        .select()
        .from(subscriptionPlanPrices)
        .where(
          and(
            eq(subscriptionPlanPrices.id, req.params.priceId),
            eq(subscriptionPlanPrices.planId, req.params.planId),
          ),
        )
        .limit(1);
      if (!price) throw ERR.SUB_001();

      const parsed = updatePlanPriceSchema.safeParse(req.body);
      if (!parsed.success)
        throw ERR.APP_001("Invalid price data", parsed.error.flatten());

      // `unit` and `usageLimit` only exist on a metered price.
      if (
        price.billingType === "fixed" &&
        (parsed.data.unit !== undefined || parsed.data.usageLimit !== undefined)
      ) {
        throw ERR.BIL_002(
          "unit and usageLimit are only valid for a metered price",
        );
      }

      const [updated] = await db
        .update(subscriptionPlanPrices)
        .set({
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.unit !== undefined ? { unit: parsed.data.unit } : {}),
          ...(parsed.data.usageLimit !== undefined
            ? { usageLimit: parsed.data.usageLimit }
            : {}),
        })
        .where(eq(subscriptionPlanPrices.id, req.params.priceId))
        .returning();

      if (parsed.data.name !== undefined) {
        await updatePlanPriceNickname(price.stripePriceId, parsed.data.name);
      }

      await reply.send({ price: updated });
    },
  );

  // DELETE /api/admin/applications/:appId/plans/:planId/prices/:priceId
  fastify.delete<{
    Params: { appId: string; planId: string; priceId: string };
  }>(
    "/applications/:appId/plans/:planId/prices/:priceId",
    async (req, reply) => {
      await ensureApp(req.params.appId);
      await ensurePlan(req.params.appId, req.params.planId);

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
          stripeMeterId: subscriptionPlanPrices.stripeMeterId,
          featureKey: subscriptionPlanPrices.featureKey,
        });
      if (!deleted) throw ERR.SUB_001();

      // Prices cannot be deleted in Stripe, only archived; a meter that no
      // other price uses stops accepting events.
      await archivePlanPrice(deleted.stripePriceId);
      if (deleted.stripeMeterId && deleted.featureKey) {
        await deactivateMeterIfUnused({
          applicationId: req.params.appId,
          featureKey: deleted.featureKey,
          stripeMeterId: deleted.stripeMeterId,
        });
      }

      await reply.status(204).send();
    },
  );
}
