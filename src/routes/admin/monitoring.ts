import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAnyRole } from "../../middleware.js";
import { getBusinessStats } from "../../services/billing/mrr.js";
import {
  getSecurityStats,
  listAdminAccessEvents,
} from "../../services/resources/monitoring.js";
import { RESOURCE_EVENT_DECISIONS } from "../../services/resources/types.js";
import { DASHBOARD_ROLES } from "../../services/roles.js";

const rangeQuerySchema = z
  .object({ range: z.enum(["7d", "30d"]).default("7d") })
  .strict();

const eventsQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    decision: z.enum(RESOURCE_EVENT_DECISIONS).optional(),
    applicationId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

// Each dashboard carries its own role list (see DASHBOARD_ROLES), not the
// plugin-wide admin hook, so one view can be opened to a dedicated role.
export async function monitoringRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const security = { preHandler: requireAnyRole(DASHBOARD_ROLES.security) };
  const business = { preHandler: requireAnyRole(DASHBOARD_ROLES.business) };

  // GET /api/admin/monitoring/security?range=7d|30d
  fastify.get("/security", security, async (req, reply) => {
    const { range } = rangeQuerySchema.parse(req.query);
    await reply.send(await getSecurityStats(range));
  });

  // GET /api/admin/monitoring/access-events
  fastify.get("/access-events", security, async (req, reply) => {
    const query = eventsQuerySchema.parse(req.query);
    await reply.send(
      await listAdminAccessEvents({
        ...query,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      }),
    );
  });

  // GET /api/admin/monitoring/business
  fastify.get("/business", business, async (_req, reply) => {
    await reply.send(await getBusinessStats());
  });
}
