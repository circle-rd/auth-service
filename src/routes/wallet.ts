import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ERR } from "../errors.js";
import { getRequestSession, requireUserOrBearer } from "../middleware.js";
import {
  createTopupCheckout,
  getOrCreateWalletAccount,
  getTopupOptions,
  getUserSpendStats,
  listWalletTransactions,
  toAccountView,
} from "../services/wallet/index.js";
import {
  listTransactionsQuerySchema,
  statsQuerySchema,
} from "./wallet-schemas.js";

const checkoutBodySchema = z.object({
  amountCents: z.number().int().positive(),
});

/** The signed-in user's own wallet. */
export async function walletRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/user/wallet
  fastify.get("/", async (req, reply) => {
    const userId = await requireUserOrBearer(req, reply, "wallet:self:read");
    if (!userId) return;
    const account = await getOrCreateWalletAccount("user", userId);
    await reply.send(toAccountView(account));
  });

  // GET /api/user/wallet/stats
  fastify.get("/stats", async (req, reply) => {
    const userId = await requireUserOrBearer(req, reply, "wallet:self:read");
    if (!userId) return;
    const { days } = statsQuerySchema.parse(req.query);
    const account = await getOrCreateWalletAccount("user", userId);
    await reply.send(await getUserSpendStats(account.id, days));
  });

  // GET /api/user/wallet/topup-options
  fastify.get("/topup-options", async (req, reply) => {
    if (!(await requireUserOrBearer(req, reply, "wallet:self:read"))) return;
    await reply.send(getTopupOptions());
  });

  // POST /api/user/wallet/checkout
  fastify.post("/checkout", async (req, reply) => {
    const session = await getRequestSession(req);
    if (!session) throw ERR.AUTH_001();
    const body = checkoutBodySchema.parse(req.body);
    const checkout = await createTopupCheckout({
      userId: session.user.id,
      email: session.user.email ?? null,
      amountCents: body.amountCents,
    });
    await reply.status(201).send(checkout);
  });

  // GET /api/user/wallet/transactions
  fastify.get("/transactions", async (req, reply) => {
    const userId = await requireUserOrBearer(req, reply, "wallet:self:read");
    if (!userId) return;
    const query = listTransactionsQuerySchema.parse(req.query);
    const account = await getOrCreateWalletAccount("user", userId);
    await reply.send(
      await listWalletTransactions({ accountId: account.id, ...query }),
    );
  });
}
