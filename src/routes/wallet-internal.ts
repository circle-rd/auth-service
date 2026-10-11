import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ERR } from "../errors.js";
import { requireMachineScope } from "../services/machine-auth.js";
import {
  idempotencyKeySchema,
  positiveAmountSchema,
  positiveDecimalSchema,
  usageMetadataSchema,
  userParamsSchema,
} from "./wallet-schemas.js";
import {
  getOrCreateWalletAccount,
  getUsdPricing,
  recordUsage,
  usdToMicroEur,
  toAccountView,
  toTransactionView,
} from "../services/wallet/index.js";

// The gateway calls once per LLM request from a single address: the global
// 600/min per-IP bucket would throttle it under load. The routes stay protected
// by a machine token with a dedicated scope.
const INTERNAL_RATE_LIMIT = {
  rateLimit: { max: 6000, timeWindow: "1 minute" },
};

// The gateway reports the provider cost (`costUsd`) and the wallet service
// prices it: no pricing rule lives in the gateway. `amount` charges an exact
// number of micro-euros instead.
const usageBodySchema = z
  .object({
    amount: positiveAmountSchema.optional(),
    costUsd: positiveDecimalSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
    applicationSlug: z.string().min(1).max(64).optional(),
    metadata: usageMetadataSchema.optional(),
  })
  .refine((b) => (b.amount === undefined) !== (b.costUsd === undefined), {
    message: "provide exactly one of amount or costUsd",
  });

/**
 * Amount to charge. Pricing facts are recorded next to it so a charge can be
 * audited and re-priced; they override any client-supplied metadata.
 */
function resolveUsageAmount(body: z.infer<typeof usageBodySchema>): {
  amount: bigint;
  pricingMetadata: Record<string, string | number>;
} {
  if (body.amount !== undefined)
    return { amount: body.amount, pricingMetadata: {} };
  if (body.costUsd === undefined) {
    throw ERR.APP_001("provide exactly one of amount or costUsd");
  }
  const pricing = getUsdPricing();
  return {
    amount: usdToMicroEur(body.costUsd, pricing),
    pricingMetadata: {
      costUsd: body.costUsd,
      usdToEurRate: pricing.usdToEurRate,
      marginPercent: pricing.marginPercent,
    },
  };
}

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

      const { amount, pricingMetadata } = resolveUsageAmount(body);
      const { transaction, replayed } = await recordUsage({
        accountId: account.id,
        amount,
        idempotencyKey: body.idempotencyKey,
        applicationSlug: body.applicationSlug,
        metadata: { ...body.metadata, ...pricingMetadata },
      });
      await reply
        .status(replayed ? 200 : 201)
        .send({ transaction: toTransactionView(transaction), replayed });
    },
  );
}
