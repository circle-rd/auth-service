import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMachineScope } from "../services/machine-auth.js";
import {
  idempotencyKeySchema,
  positiveAmountSchema,
  usageMetadataSchema,
  userParamsSchema,
} from "./wallet-schemas.js";
import {
  getOrCreateWalletAccount,
  recordUsage,
  toAccountView,
  toTransactionView,
} from "../services/wallet/index.js";

// The gateway calls once per LLM request from a single address: the global
// 600/min per-IP bucket would throttle it under load. The routes stay protected
// by a machine token with a dedicated scope.
const INTERNAL_RATE_LIMIT = {
  rateLimit: { max: 6000, timeWindow: "1 minute" },
};

const usageBodySchema = z.object({
  amount: positiveAmountSchema,
  idempotencyKey: idempotencyKeySchema,
  applicationSlug: z.string().min(1).max(64).optional(),
  metadata: usageMetadataSchema.optional(),
});

/** Machine-to-machine wallet API used by the LLM gateway. */
export async function walletInternalRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // GET /api/internal/wallet/users/:userId
  fastify.get(
    "/users/:userId",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(req.headers.authorization, "wallet:read");
      const { userId } = userParamsSchema.parse(req.params);
      const account = await getOrCreateWalletAccount("user", userId);
      await reply.send(toAccountView(account));
    },
  );

  // POST /api/internal/wallet/users/:userId/usage
  fastify.post(
    "/users/:userId/usage",
    { config: INTERNAL_RATE_LIMIT },
    async (req, reply) => {
      await requireMachineScope(req.headers.authorization, "wallet:debit");
      const { userId } = userParamsSchema.parse(req.params);
      const body = usageBodySchema.parse(req.body);

      const account = await getOrCreateWalletAccount("user", userId);
      const { transaction, replayed } = await recordUsage({
        accountId: account.id,
        amount: body.amount,
        idempotencyKey: body.idempotencyKey,
        applicationSlug: body.applicationSlug,
        metadata: body.metadata,
      });
      await reply
        .status(replayed ? 200 : 201)
        .send({ transaction: toTransactionView(transaction), replayed });
    },
  );
}
