import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMachineScope } from "../services/machine-auth.js";
import { resolveGatewayPlan } from "../services/litellm-plan.js";
import { userParamsSchema } from "./wallet-schemas.js";

// The gateway asks once per request the user is not already cached for; the
// global 600/min per-IP bucket would throttle it. The routes stay protected by a
// machine token with a dedicated scope.
const INTERNAL_RATE_LIMIT = {
  rateLimit: { max: 6000, timeWindow: "1 minute" },
};

const planQuerySchema = z.object({
  applicationSlug: z.string().min(1).max(64),
});

/**
 * Machine-to-machine API the gateway (LiteLLM) uses to turn a user's session
 * into the team of the plan they hold for the calling application.
 */
export async function gatewayInternalRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // GET /api/internal/gateway/users/:userId/plan?applicationSlug=...
  fastify.get(
    "/users/:userId/plan",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(req.headers.authorization, "wallet:read");
      const { userId } = userParamsSchema.parse(req.params);
      const { applicationSlug } = planQuerySchema.parse(req.query);
      const plan = await resolveGatewayPlan(userId, applicationSlug);
      await reply.send(
        plan
          ? { plan: plan.planName, teamId: plan.teamId }
          : { plan: null, teamId: null },
      );
    },
  );
}
