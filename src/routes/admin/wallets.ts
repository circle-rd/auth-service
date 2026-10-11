import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ERR } from "../../errors.js";
import { getRequestSession, requireAdmin } from "../../middleware.js";
import {
  adjustBalance,
  getAdminWalletStats,
  getOrCreateWalletAccount,
  getUserSpendStats,
  grantCredit,
  listGatewayUsage,
  listWalletAccounts,
  listWalletTransactions,
  recordManualTopup,
  setWalletUnlimited,
  toAccountView,
  toTransactionView,
} from "../../services/wallet/index.js";
import {
  idempotencyKeySchema,
  listTransactionsQuerySchema,
  listWalletsQuerySchema,
  positiveAmountSchema,
  reasonSchema,
  signedAmountSchema,
  statsQuerySchema,
  usageLedgerQuerySchema,
  userParamsSchema,
} from "../wallet-schemas.js";

const grantBodySchema = z.object({
  amount: positiveAmountSchema,
  idempotencyKey: idempotencyKeySchema,
  reason: reasonSchema,
});

const manualTopupBodySchema = z.object({
  amount: positiveAmountSchema,
  idempotencyKey: idempotencyKeySchema,
  // Invoice or transfer number the credit was issued against.
  reference: z.string().trim().min(1).max(100),
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

/** Balance changes made by an administrator leave a trace in the logs, next to the ledger. */
function logAdminWrite(
  req: FastifyRequest,
  action: string,
  fields: {
    actorId: string;
    userId: string;
    amount?: bigint;
    replayed?: boolean;
  },
): void {
  req.log.info(
    { ...fields, amount: fields.amount?.toString() },
    `wallet ${action}`,
  );
}

export async function adminWalletRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  // GET /api/admin/wallets
  fastify.get("/", async (req, reply) => {
    const query = listWalletsQuerySchema.parse(req.query);
    const { wallets, total } = await listWalletAccounts(query);
    await reply.send({ wallets, total, page: query.page, limit: query.limit });
  });

  // GET /api/admin/wallets/stats
  fastify.get("/stats", async (req, reply) => {
    const { days } = statsQuerySchema.parse(req.query);
    await reply.send(await getAdminWalletStats(days));
  });

  // GET /api/admin/wallets/usage-ledger
  fastify.get("/usage-ledger", async (req, reply) => {
    const query = usageLedgerQuerySchema.parse(req.query);
    await reply.send(await listGatewayUsage(query));
  });

  // GET /api/admin/wallets/users/:userId/stats
  fastify.get("/users/:userId/stats", async (req, reply) => {
    const { userId } = userParamsSchema.parse(req.params);
    const { days } = statsQuerySchema.parse(req.query);
    const account = await getOrCreateWalletAccount("user", userId);
    await reply.send(await getUserSpendStats(account.id, days));
  });

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
    logAdminWrite(req, "grant", {
      actorId,
      userId,
      amount: body.amount,
      replayed,
    });
    await reply
      .status(replayed ? 200 : 201)
      .send({ transaction: toTransactionView(transaction), replayed });
  });

  // POST /api/admin/wallets/users/:userId/topups
  fastify.post("/users/:userId/topups", async (req, reply) => {
    const actorId = await requireSuperadminActor(req);
    const { userId } = userParamsSchema.parse(req.params);
    const body = manualTopupBodySchema.parse(req.body);
    const account = await getOrCreateWalletAccount("user", userId);
    const { transaction, replayed } = await recordManualTopup({
      accountId: account.id,
      amount: body.amount,
      idempotencyKey: body.idempotencyKey,
      actorId,
      reference: body.reference,
    });
    logAdminWrite(req, "top-up", {
      actorId,
      userId,
      amount: body.amount,
      replayed,
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
    logAdminWrite(req, "adjustment", {
      actorId,
      userId,
      amount: body.amount,
      replayed,
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
    logAdminWrite(req, "unlimited access changed", { actorId, userId });
    await reply.send(toAccountView(updated));
  });
}
