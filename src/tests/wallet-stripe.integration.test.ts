import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { walletTransactions } from "../db/schema.js";
import {
  MICRO_PER_EUR,
  debitWallet,
  getOrCreateWalletAccount,
  handleWalletStripeEvent,
} from "../services/wallet/index.js";
import { cleanDb } from "./helpers/db.js";

const TEN_EUR = 10n * MICRO_PER_EUR;

async function seedWallet(): Promise<{ userId: string; accountId: string }> {
  await db.insert(user).values({
    id: "u1",
    name: "u1",
    email: "u1@example.com",
    emailVerified: true,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const account = await getOrCreateWalletAccount("user", "u1");
  return { userId: "u1", accountId: account.id };
}

function event(type: string, object: unknown): Stripe.Event {
  return { id: `evt_${Math.random()}`, type, data: { object } } as Stripe.Event;
}

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    payment_status: "paid",
    payment_intent: "pi_1",
    currency: "usd",
    amount_total: 1100,
    metadata: {
      purpose: "wallet_topup",
      userId: "u1",
      creditMicro: TEN_EUR.toString(),
    },
    ...overrides,
  };
}

function charge(refunded: number, overrides: Record<string, unknown> = {}) {
  return {
    id: "ch_1",
    payment_intent: "pi_1",
    amount_captured: 1100,
    amount_refunded: refunded,
    ...overrides,
  };
}

async function balance(accountId: string): Promise<bigint> {
  const rows = await db
    .select({ balanceAfter: walletTransactions.balanceAfter })
    .from(walletTransactions)
    .where(eq(walletTransactions.accountId, accountId))
    .orderBy(walletTransactions.createdAt);
  return rows.length === 0 ? 0n : rows[rows.length - 1]!.balanceAfter;
}

async function ledger(accountId: string) {
  return db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.accountId, accountId))
    .orderBy(walletTransactions.createdAt);
}

const pay = (session = checkoutSession()) =>
  handleWalletStripeEvent(event("checkout.session.completed", session));

beforeEach(async () => {
  await cleanDb();
});

describe("checkout completion", () => {
  it("credits the euro amount from the metadata, whatever currency was charged", async () => {
    const { accountId } = await seedWallet();
    expect(await pay()).toBe(true);
    const rows = await ledger(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "topup", amount: TEN_EUR, idempotencyKey: "stripe:checkout:cs_1" });
    expect(rows[0]!.metadata).toMatchObject({
      source: "stripe",
      paymentIntentId: "pi_1",
      chargedCurrency: "usd",
      chargedAmount: 1100,
    });
  });

  it("credits once when Stripe delivers the same payment twice", async () => {
    const { accountId } = await seedWallet();
    await pay();
    await pay();
    await handleWalletStripeEvent(event("checkout.session.async_payment_succeeded", checkoutSession()));
    expect(await ledger(accountId)).toHaveLength(1);
    expect(await balance(accountId)).toBe(TEN_EUR);
  });

  it("waits for an asynchronous payment to be confirmed", async () => {
    const { accountId } = await seedWallet();
    expect(await pay(checkoutSession({ payment_status: "unpaid" }))).toBe(true);
    expect(await ledger(accountId)).toHaveLength(0);
    await handleWalletStripeEvent(event("checkout.session.async_payment_succeeded", checkoutSession()));
    expect(await balance(accountId)).toBe(TEN_EUR);
  });

  it("ignores a checkout that did not buy credit", async () => {
    await seedWallet();
    expect(await pay(checkoutSession({ metadata: {} }))).toBe(false);
    expect(await pay(checkoutSession({ metadata: { purpose: "subscription" } }))).toBe(false);
  });

  it("fails loudly on a malformed top-up session so Stripe retries", async () => {
    await seedWallet();
    await expect(
      pay(checkoutSession({ metadata: { purpose: "wallet_topup", userId: "u1", creditMicro: "-5" } })),
    ).rejects.toThrow();
  });

  it("fails loudly when the buyer no longer exists", async () => {
    await expect(pay()).rejects.toMatchObject({ code: "USR_001" });
  });

  it("reports events that are not about the wallet", async () => {
    expect(await handleWalletStripeEvent(event("customer.subscription.created", {}))).toBe(false);
  });
});

describe("refunds", () => {
  it("takes back the refunded share of the credit", async () => {
    const { accountId } = await seedWallet();
    await pay();
    expect(await handleWalletStripeEvent(event("charge.refunded", charge(550)))).toBe(true);
    const rows = await ledger(accountId);
    expect(rows[1]).toMatchObject({ type: "reversal", amount: -TEN_EUR / 2n, balanceAfter: TEN_EUR / 2n });
    expect(rows[1]!.metadata).toMatchObject({ source: "stripe", reason: "refund", paymentIntentId: "pi_1", chargeId: "ch_1" });
  });

  it("reverses only the new part of a cumulative refund and never more than the credit", async () => {
    const { accountId } = await seedWallet();
    await pay();
    await handleWalletStripeEvent(event("charge.refunded", charge(550)));
    await handleWalletStripeEvent(event("charge.refunded", charge(1100)));
    await handleWalletStripeEvent(event("charge.refunded", charge(1500)));
    expect(await balance(accountId)).toBe(0n);
    const reversals = (await ledger(accountId)).filter((r) => r.type === "reversal");
    expect(reversals.map((r) => r.amount)).toEqual([-TEN_EUR / 2n, -TEN_EUR / 2n]);
  });

  it("applies a replayed refund once", async () => {
    const { accountId } = await seedWallet();
    await pay();
    await handleWalletStripeEvent(event("charge.refunded", charge(1100)));
    await handleWalletStripeEvent(event("charge.refunded", charge(1100)));
    expect((await ledger(accountId)).filter((r) => r.type === "reversal")).toHaveLength(1);
  });

  it("leaves the wallet in debt when the credit was already spent", async () => {
    const { accountId } = await seedWallet();
    await pay();
    await debitWallet({ accountId, type: "usage", amount: 8n * MICRO_PER_EUR, idempotencyKey: "u1" });
    await handleWalletStripeEvent(event("charge.refunded", charge(1100)));
    expect(await balance(accountId)).toBe(-8n * MICRO_PER_EUR);
  });

  it("does not reverse the same share twice when two events race", async () => {
    const { accountId } = await seedWallet();
    await pay();
    await Promise.all([
      handleWalletStripeEvent(event("charge.refunded", charge(550))),
      handleWalletStripeEvent(event("charge.refunded", charge(1100))),
    ]);
    expect(await balance(accountId)).toBe(0n);
    const total = (await ledger(accountId))
      .filter((r) => r.type === "reversal")
      .reduce((sum, r) => sum - r.amount, 0n);
    expect(total).toBe(TEN_EUR);
  });

  it("ignores a refund of a payment that did not buy credit", async () => {
    await seedWallet();
    expect(await handleWalletStripeEvent(event("charge.refunded", charge(1100, { payment_intent: "pi_other" })))).toBe(false);
    expect(await handleWalletStripeEvent(event("charge.refunded", charge(1100, { payment_intent: null })))).toBe(false);
  });
});

describe("disputes", () => {
  const dispute = (overrides: Record<string, unknown> = {}) => ({
    id: "dp_1",
    charge: "ch_1",
    payment_intent: "pi_1",
    ...overrides,
  });

  it("takes back the whole remaining credit when a dispute opens", async () => {
    const { accountId } = await seedWallet();
    await pay();
    await handleWalletStripeEvent(event("charge.refunded", charge(275)));
    expect(await handleWalletStripeEvent(event("charge.dispute.created", dispute()))).toBe(true);
    expect(await balance(accountId)).toBe(0n);
    const rows = await ledger(accountId);
    expect(rows[rows.length - 1]!.metadata).toMatchObject({ reason: "dispute" });
  });

  it("is applied once and does not add to a later refund", async () => {
    const { accountId } = await seedWallet();
    await pay();
    await handleWalletStripeEvent(event("charge.dispute.created", dispute()));
    await handleWalletStripeEvent(event("charge.dispute.created", dispute()));
    await handleWalletStripeEvent(event("charge.refunded", charge(1100)));
    expect((await ledger(accountId)).filter((r) => r.type === "reversal")).toHaveLength(1);
    expect(await balance(accountId)).toBe(0n);
  });

  it("ignores a dispute without a payment intent", async () => {
    await seedWallet();
    expect(await handleWalletStripeEvent(event("charge.dispute.created", dispute({ payment_intent: null })))).toBe(false);
  });
});
