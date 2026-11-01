import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ERR } from "../errors.js";
import { requireMachineApplication } from "../services/machine-auth.js";
import {
  getApplicationSubscription,
  getApplicationUsage,
} from "../services/billing/app-views.js";
import { listApplicationInvoices } from "../services/billing/invoices.js";
import { userParamsSchema } from "./wallet-schemas.js";

// An application's backend calls these once per page view of its own billing
// screens: the global 600/min per-IP bucket would throttle a busy one. The
// routes stay protected by a client_credentials token with `billing:read`.
const APP_RATE_LIMIT = {
  rateLimit: { max: 3000, timeWindow: "1 minute" },
};

const invoicesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

async function callerApplicationId(req: FastifyRequest): Promise<string> {
  const { applicationId } = await requireMachineApplication(
    req.headers.authorization,
    "billing:read",
  );
  return applicationId;
}

/**
 * Application read API: a user's subscription, metered usage and invoices, for
 * the calling application only. Used by applications that present billing
 * themselves (the delegated template pages use the same views).
 */
export async function appBillingRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // GET /api/app/billing/users/:userId/subscription
  fastify.get(
    "/users/:userId/subscription",
    { config: APP_RATE_LIMIT },
    async (req, reply) => {
      const applicationId = await callerApplicationId(req);
      const { userId } = userParamsSchema.parse(req.params);
      await reply.send({
        subscription: await getApplicationSubscription({
          userId,
          applicationId,
        }),
      });
    },
  );

  // GET /api/app/billing/users/:userId/usage
  fastify.get(
    "/users/:userId/usage",
    { config: APP_RATE_LIMIT },
    async (req, reply) => {
      const applicationId = await callerApplicationId(req);
      const { userId } = userParamsSchema.parse(req.params);
      await reply.send(await getApplicationUsage({ userId, applicationId }));
    },
  );

  // GET /api/app/billing/users/:userId/invoices?limit=&cursor=
  fastify.get(
    "/users/:userId/invoices",
    { config: APP_RATE_LIMIT },
    async (req, reply) => {
      const applicationId = await callerApplicationId(req);
      const { userId } = userParamsSchema.parse(req.params);
      const query = invoicesQuerySchema.safeParse(req.query);
      if (!query.success)
        throw ERR.APP_001("Invalid query", query.error.flatten());
      await reply.send(
        await listApplicationInvoices({
          userId,
          applicationId,
          limit: query.data.limit,
          cursor: query.data.cursor,
        }),
      );
    },
  );
}
