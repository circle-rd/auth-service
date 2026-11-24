import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMachineScope } from "../services/machine-auth.js";
import { listGatewayEntitlements } from "../services/gateway-inventory.js";
import { requestGatewayInventorySync } from "../services/gateway-inventory-sync.js";
import { userParamsSchema } from "./wallet-schemas.js";

const INTERNAL_RATE_LIMIT = {
  rateLimit: { max: 6000, timeWindow: "1 minute" },
};

const INVENTORY_NOTIFY_RATE_LIMIT = {
  rateLimit: { max: 60, timeWindow: "1 minute" },
};

const entitlementsQuerySchema = z
  .object({ applicationSlug: z.string().min(1).max(64).optional() })
  .strict();

/**
 * Machine-to-machine API the LiteLLM hook uses to resolve what a user may reach.
 * The list is global: shared resources come from any application the subject
 * belongs to. `applicationSlug` is accepted for audit and future scoping but is
 * not used to narrow the decision.
 */
export async function gatewayInternalRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/users/:userId/entitlements",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(
        req.headers.authorization,
        "gateway:entitlements:read",
      );
      const { userId } = userParamsSchema.parse(req.params);
      entitlementsQuerySchema.parse(req.query);
      await reply.send(await listGatewayEntitlements(userId));
    },
  );

  fastify.post(
    "/inventory-changed",
    { config: INVENTORY_NOTIFY_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(
        req.headers.authorization,
        "gateway:inventory:sync",
      );
      requestGatewayInventorySync();
      await reply.status(202).send();
    },
  );
}
