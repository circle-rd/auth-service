import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ERR } from "../../errors.js";
import { getRequestSession, requireAdmin } from "../../middleware.js";
import {
  adjustBalance,
  getOrCreateWalletAccount,
  grantCredit,
  listWalletTransactions,
  setWalletUnlimited,
  toAccountView,
  toTransactionView,
} from "../../services/wallet/index.js";
import {
  idempotencyKeySchema,
  listTransactionsQuerySchema,
  positiveAmountSchema,
  reasonSchema,
  signedAmountSchema,
  userParamsSchema,
} from "../wallet-schemas.js";

const grantBodySchema = z.object({
  amount: positiveAmountSchema,
  idempotencyKey: idempotencyKeySchema,
  reason: reasonSchema,
});

const adjustmentBodySchema = z.object({
  amount: signedAmountSchema,
  idempotencyKey: idempotencyKeySchema,
  reason: reasonSchema,
});

const unlimitedBodySchema = z.object({
  isUnlimited: z.boolean(),
  reason: reasonSchema,
});

/** Creating or removing credit is superadmin-only; returns the actor id. */
async function requireSuperadminActor(req: FastifyRequest): Promise<string> {
  const session = await getRequestSession(req);
  if (!session) throw ERR.AUTH_001();
  const role = (session.user as Record<string, unknown>).role;
  if (role !== "superadmin") {
    throw ERR.AUTH_011("Only superadmins can change wallet balances");
  }
  return session.user.id;
}

export async function adminWalletRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // GET /api/admin/wallets/users/:userId
  fastify.get("/users/:userId", async (req, reply) => {
    const { userId } = userParamsSchema.parse(req.params);
    const account = await getOrCreateWalletAccount("user", userId);
    await reply.send(toAccountView(account));
  });

  // GET /api/admin/wallets/users/:userId/transactions
  fastify.get("/users/:userId/transactions", async (req, reply) => {
    const { userId } = userParamsSchema.parse(req.params);
    const query = listTransactionsQuerySchema.parse(req.query);
    const account = await getOrCreateWalletAccount("user", userId);
    await reply.send(
      await listWalletTransactions({ accountId: account.id, ...query }),
    );
  });

  // POST /api/admin/wallets/users/:userId/grants
  fastify.post("/users/:userId/grants", async (req, reply) => {
    const actorId = await requireSuperadminActor(req);
    const { userId } = userParamsSchema.parse(req.params);
    const body = grantBodySchema.parse(req.body);
    const account = await getOrCreateWalletAccount("user", userId);
    const { transaction, replayed } = await grantCredit({
      accountId: account.id,
      amount: body.amount,
      idempotencyKey: body.idempotencyKey,
      actorId,
      reason: body.reason,
    });
    await reply
      .status(replayed ? 200 : 201)
      .send({ transaction: toTransactionView(transaction), replayed });
  });

  // POST /api/admin/wallets/users/:userId/adjustments
  fastify.post("/users/:userId/adjustments", async (req, reply) => {
    const actorId = await requireSuperadminActor(req);
    const { userId } = userParamsSchema.parse(req.params);
    const body = adjustmentBodySchema.parse(req.body);
    const account = await getOrCreateWalletAccount("user", userId);
    const { transaction, replayed } = await adjustBalance({
      accountId: account.id,
      amount: body.amount,
      idempotencyKey: body.idempotencyKey,
      actorId,
      reason: body.reason,
    });
    await reply
      .status(replayed ? 200 : 201)
      .send({ transaction: toTransactionView(transaction), replayed });
  });

  // PUT /api/admin/wallets/users/:userId/unlimited
  fastify.put("/users/:userId/unlimited", async (req, reply) => {
    const actorId = await requireSuperadminActor(req);
    const { userId } = userParamsSchema.parse(req.params);
    const body = unlimitedBodySchema.parse(req.body);
    const account = await getOrCreateWalletAccount("user", userId);
    const updated = await setWalletUnlimited({
      accountId: account.id,
      isUnlimited: body.isUnlimited,
      actorId,
      reason: body.reason,
    });
    await reply.send(toAccountView(updated));
  });
}
