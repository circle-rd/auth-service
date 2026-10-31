import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireMachineApplication } from "../services/machine-auth.js";
import {
  consumptionKeySchema,
  consumptionReportSchema,
  getConsumption,
  listConsumption,
  parseConsumptionReport,
  recordConsumption,
  toReportResponse,
} from "../services/consumption.js";
import { userParamsSchema } from "./wallet-schemas.js";

// An application's backend reports usage as it happens: the global 600/min
// per-IP bucket would throttle a busy one. The routes stay protected by a
// client_credentials token carrying the consumption scope they require.
const APP_RATE_LIMIT = {
  rateLimit: { max: 3000, timeWindow: "1 minute" },
};

const userKeyParamsSchema = userParamsSchema.extend({
  key: consumptionKeySchema,
});

async function callerApplicationId(
  req: FastifyRequest,
  scope: "consumption:read" | "consumption:write",
): Promise<string> {
  const { applicationId } = await requireMachineApplication(
    req.headers.authorization,
    scope,
  );
  return applicationId;
}

/**
 * Application consumption API: usage reported and read for the calling
 * application only, whose id comes from the token. The dashboard keeps using
 * `/api/consumption`, which takes the application id explicitly.
 */
export async function appConsumptionRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // POST /api/app/consumption/users/:userId
  fastify.post(
    "/users/:userId",
    { config: APP_RATE_LIMIT },
    async (req, reply) => {
      const applicationId = await callerApplicationId(req, "consumption:write");
      const { userId } = userParamsSchema.parse(req.params);
      const { key, value, idempotencyKey } = parseConsumptionReport(
        consumptionReportSchema,
        req.body,
      );
      await reply.send(
        toReportResponse(
          await recordConsumption({
            userId,
            applicationId,
            key,
            value,
            idempotencyKey,
          }),
        ),
      );
    },
  );

  // GET /api/app/consumption/users/:userId
  fastify.get(
    "/users/:userId",
    { config: APP_RATE_LIMIT },
    async (req, reply) => {
      const applicationId = await callerApplicationId(req, "consumption:read");
      const { userId } = userParamsSchema.parse(req.params);
      await reply.send({
        aggregates: await listConsumption(userId, applicationId),
      });
    },
  );

  // GET /api/app/consumption/users/:userId/:key
  fastify.get(
    "/users/:userId/:key",
    { config: APP_RATE_LIMIT },
    async (req, reply) => {
      const applicationId = await callerApplicationId(req, "consumption:read");
      const { userId, key } = userKeyParamsSchema.parse(req.params);
      await reply.send({
        aggregate: await getConsumption(userId, applicationId, key),
      });
    },
  );
}
