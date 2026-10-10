import type { FastifyInstance } from "fastify";
import { requireSession } from "../middleware.js";
import {
  getOrCreateWalletAccount,
  listWalletTransactions,
  toAccountView,
} from "../services/wallet/index.js";
import { listTransactionsQuerySchema } from "./wallet-schemas.js";

/** The signed-in user's own wallet. */
export async function walletRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/user/wallet
  fastify.get("/", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const account = await getOrCreateWalletAccount("user", userId);
    await reply.send(toAccountView(account));
  });

  // GET /api/user/wallet/transactions
  fastify.get("/transactions", async (req, reply) => {
    const userId = await requireSession(req, reply);
    if (!userId) return;
    const query = listTransactionsQuerySchema.parse(req.query);
    const account = await getOrCreateWalletAccount("user", userId);
    await reply.send(
      await listWalletTransactions({ accountId: account.id, ...query }),
    );
  });
}
