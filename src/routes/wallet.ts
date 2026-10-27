import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ERR } from "../errors.js";
import { getRequestSession, requireUserOrBearer } from "../middleware.js";
import {
  createTopupCheckout,
  getOrCreateWalletAccount,
  getSessionUsage,
  getTopupOptions,
  getUserSpendStats,
  listWalletTransactions,
  toAccountView,
} from "../services/wallet/index.js";
import { verifyBearerAccessToken } from "../services/oauth-tokens.js";
import {
  listTransactionsQuerySchema,
  sessionUsageQuerySchema,
  statsQuerySchema,
} from "./wallet-schemas.js";

const checkoutBodySchema = z.object({
  amountCents: z.number().int().positive(),
});

/**
 * The application behind a bearer token (its `azp`, the immutable OAuth client
 * id), or undefined for a session cookie. Used to bind a session query to the
 * application that made the calls, so two applications cannot read each other's
 * identical session ids.
 */
async function callerApplicationSlug(
  req: FastifyRequest,
): Promise<string | undefined> {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const verified = await verifyBearerAccessToken(authorization.slice(7));
  return verified?.clientId ?? undefined;
}

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

  // GET /api/user/wallet/usage?sessionId=...&days=...
  // What a chat session spent, for the application calling on its user's behalf.
  fastify.get("/usage", async (req, reply) => {
    const userId = await requireUserOrBearer(req, reply, "wallet:self:read");
    if (!userId) return;
    const { sessionId, days } = sessionUsageQuerySchema.parse(req.query);
    const account = await getOrCreateWalletAccount("user", userId);
    const applicationSlug = await callerApplicationSlug(req);
    await reply.send(
      await getSessionUsage({
        accountId: account.id,
        sessionId,
        applicationSlug,
        days,
      }),
    );
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
