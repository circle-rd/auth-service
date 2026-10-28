import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../middleware.js";
import { setCancelAtPeriodEnd } from "../../services/billing/subscriptions.js";
import { notifySubscriptionChanged } from "../../services/subscriptions.js";

const paramsSchema = z.object({
  appId: z.string().uuid(),
  userId: z.string().min(1).max(255),
});

/**
 * Administrators stop or resume a user's Stripe subscription at the end of its
 * period. Immediate cancellation and plan changes stay in the subscription
 * routes, which keep the audit trail of plan changes.
 */
export async function subscriptionBillingRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // POST /api/admin/applications/:appId/users/:userId/subscription/cancel
  fastify.post<{ Params: { appId: string; userId: string } }>(
    "/:appId/users/:userId/subscription/cancel",
    async (req, reply) => {
      const { appId, userId } = paramsSchema.parse(req.params);
      await setCancelAtPeriodEnd({
        userId,
        applicationId: appId,
        cancel: true,
      });
      notifySubscriptionChanged();
      await reply.send({ ok: true, cancelAtPeriodEnd: true });
    },
  );

  // POST /api/admin/applications/:appId/users/:userId/subscription/resume
  fastify.post<{ Params: { appId: string; userId: string } }>(
    "/:appId/users/:userId/subscription/resume",
    async (req, reply) => {
      const { appId, userId } = paramsSchema.parse(req.params);
      await setCancelAtPeriodEnd({
        userId,
        applicationId: appId,
        cancel: false,
      });
      notifySubscriptionChanged();
      await reply.send({ ok: true, cancelAtPeriodEnd: false });
    },
  );
}
