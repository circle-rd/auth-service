import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ERR } from "../errors.js";
import { requireMachineScope } from "../services/machine-auth.js";
import {
  resolveGatewayKey,
  touchGatewayKeyLastUsed,
} from "../services/gateway-keys.js";
import { listGatewayEntitlements } from "../services/gateway-inventory.js";
import { requestGatewayInventorySync } from "../services/gateway-inventory-sync.js";
import { verifyBearerAccessToken } from "../services/oauth-tokens.js";
import { loadSharingApplicationBySlug } from "../services/resources/application-scope.js";
import { signDecision } from "../services/resources/decision-token.js";

const INTERNAL_RATE_LIMIT = {
  rateLimit: { max: 6000, timeWindow: "1 minute" },
};

const INVENTORY_NOTIFY_RATE_LIMIT = {
  rateLimit: { max: 60, timeWindow: "1 minute" },
};

const entitlementsBodySchema = z
  .object({ token: z.string().min(20).max(8192) })
  .strict();

const personalKeyBodySchema = z.object({ key: z.string() }).strict();

/**
 * Machine-to-machine API the LiteLLM hook uses to resolve what a user may reach.
 * The hook does not say who the user is or which application they came through:
 * it forwards the user's access token and auth-service derives both, so a
 * compromised gateway can only replay tokens it has already seen. The answer is
 * limited to the application the token was issued to.
 */
export async function gatewayInternalRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post(
    "/entitlements",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      const machine = await requireMachineScope(
        req.headers.authorization,
        "gateway:entitlements:read",
      );
      const { token } = entitlementsBodySchema.parse(req.body);
      const verified = await verifyBearerAccessToken(token);
      if (!verified) throw ERR.AUTH_001("Invalid or expired access token");
      if (verified.userId === null) {
        throw ERR.AUTH_011("A user-bound access token is required");
      }
      const application = await loadSharingApplicationBySlug(verified.clientId);
      if (!application) {
        throw ERR.AUTH_011(
          "The token was not issued to an application with resource sharing",
        );
      }
      const caller = { id: application.id, slug: application.slug };
      const { decisionId, expiresAt } = signDecision({
        sub: verified.userId,
        app: application.slug,
        by: machine.clientId,
        notAfter: verified.expiresAt,
      });
      await reply.send({
        subjectId: verified.userId,
        clientId: application.slug,
        decisionId,
        expiresAt: expiresAt.toISOString(),
        ...(await listGatewayEntitlements(verified.userId, caller)),
      });
    },
  );

  fastify.post(
    "/personal-keys/entitlements",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      const machine = await requireMachineScope(
        req.headers.authorization,
        "gateway:entitlements:read",
      );
      const parsed = personalKeyBodySchema.safeParse(req.body);
      if (!parsed.success) throw ERR.KEY_003();
      const resolved = await resolveGatewayKey(parsed.data.key);
      const entitlements = await listGatewayEntitlements(
        resolved.userId,
        resolved.caller,
        resolved.pool !== null ? { pool: resolved.pool } : {},
      );
      await touchGatewayKeyLastUsed(resolved.keyId);
      const { decisionId, expiresAt } = signDecision({
        sub: resolved.userId,
        app: resolved.caller.slug,
        by: machine.clientId,
        notAfter: null,
        key: resolved.keyId,
      });
      await reply.send({
        keyId: resolved.keyId,
        subjectId: resolved.userId,
        clientId: resolved.caller.slug,
        decisionId,
        expiresAt: expiresAt.toISOString(),
        ...entitlements,
      });
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
