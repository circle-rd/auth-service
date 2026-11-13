import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMachineScope } from "../services/machine-auth.js";
import { RESOURCE_TYPES } from "../services/resource-uri.js";
import { listAccessibleResources } from "../services/resource-sharing/accessible.js";
import { authorize } from "../services/resource-sharing/policy.js";

const INTERNAL_RATE_LIMIT = {
  rateLimit: { max: 6000, timeWindow: "1 minute" },
};

const authorizeBodySchema = z.object({
  subjectId: z.string().min(1).max(256),
  clientId: z.string().min(1).max(256),
  resourceType: z.enum(RESOURCE_TYPES),
  key: z.string().min(1).max(512),
  audience: z.string().min(1).max(2048),
  requestId: z.string().min(1).max(256),
});

const accessibleQuerySchema = z.object({
  subjectId: z.string().min(1).max(256),
  clientId: z.string().min(1).max(256),
  resourceType: z.enum(RESOURCE_TYPES),
  audience: z.string().min(1).max(2048),
});

/**
 * Machine-scoped endpoints the gateway calls per request. Mounted only when
 * RESOURCE_SHARING_ENABLED is on, so the flag-off deployment has no new route.
 */
export async function gatewayResourceRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post(
    "/authorize",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(
        req.headers.authorization,
        "resources:authorize",
      );
      const body = authorizeBodySchema.parse(req.body);
      const decision = await authorize({
        subjectId: body.subjectId,
        clientId: body.clientId,
        resourceType: body.resourceType,
        key: body.key,
        audience: body.audience,
      });
      if (decision.decision === "deny") {
        await reply.send({ decision: "deny" });
        return;
      }
      await reply.send({
        decision: "allow",
        ownerApplicationSlug: decision.ownerApplicationSlug,
        planName: decision.planName,
        teamId: decision.teamId,
        resourceId: decision.resourceId,
      });
    },
  );

  fastify.get(
    "/resources/accessible",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(
        req.headers.authorization,
        "resources:authorize",
      );
      const query = accessibleQuerySchema.parse(req.query);
      const resources = await listAccessibleResources(query);
      await reply.send({ resources });
    },
  );
}
