import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { walletAutoTopups, walletTransactions } from "../db/schema.js";
import {
  creditWallet,
  getOrCreateWalletAccount,
  recordUsage,
} from "../services/wallet/index.js";
import { sweepAutoTopups } from "../services/wallet/auto-topup-charge.js";

const { stripeHolder, previousWebhookSecret, mocks } = vi.hoisted(() => {
  // config is validated at import time: the secret must exist before it loads.
  const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const mocks = {
    constructEvent: vi.fn(),
    customersCreate: vi.fn(),
    customersRetrieve: vi.fn(),
    sessionsCreate: vi.fn(),
    setupIntentsRetrieve: vi.fn(),
    invoicesCreate: vi.fn(),
    invoicesRetrieve: vi.fn(),
    invoicesFinalize: vi.fn(),
    invoicesPay: vi.fn(),
    invoicesVoid: vi.fn(),
    invoicesDel: vi.fn(),
    invoiceItemsCreate: vi.fn(),
    invoicePaymentsList: vi.fn(),
  };
  return {
    mocks,
    previousWebhookSecret,
    stripeHolder: {
      stripe: {
        webhooks: { constructEvent: mocks.constructEvent },
        customers: {
          create: mocks.customersCreate,
          retrieve: mocks.customersRetrieve,
        },
        checkout: { sessions: { create: mocks.sessionsCreate } },
        setupIntents: { retrieve: mocks.setupIntentsRetrieve },
        invoices: {
          create: mocks.invoicesCreate,
          retrieve: mocks.invoicesRetrieve,
          finalizeInvoice: mocks.invoicesFinalize,
          pay: mocks.invoicesPay,
          voidInvoice: mocks.invoicesVoid,
          del: mocks.invoicesDel,
        },
        invoiceItems: { create: mocks.invoiceItemsCreate },
        invoicePayments: { list: mocks.invoicePaymentsList },
      } as unknown,
    },
  };
});

vi.mock("../services/stripe.js", () => ({
  get stripe() {
    return stripeHolder.stripe;
  },
}));

let handle: AuthServerHandle;
let userId: string;
let cookie: string;
let accountId: string;
let eventSeq = 0;

beforeAll(async () => {
  handle = await makeAuthServer();
  const signedIn = await signUpAndSignIn(handle, {
    email: "payer@example.com",
    password: "Password123!",
    name: "Payer",
  });
  cookie = signedIn.cookie;
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, "payer@example.com"));
  userId = row!.id;
});

afterAll(async () => {
  await handle.cleanup();
  if (previousWebhookSecret === undefined) {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  } else {
    process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
  }
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE
    wallet_auto_topups, wallet_transactions, wallet_accounts,
    billing_customers, stripe_events, stripe_invoices
    RESTART IDENTITY CASCADE`);
  handle.capture.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();

  mocks.customersCreate.mockResolvedValue({ id: "cus_1" });
  mocks.customersRetrieve.mockResolvedValue({
    id: "cus_1",
    invoice_settings: { default_payment_method: "pm_default" },
  });
  mocks.sessionsCreate.mockResolvedValue({ url: "https://checkout.test/setup" });
  mocks.invoicesCreate.mockResolvedValue({ id: "in_1" });
  mocks.invoiceItemsCreate.mockResolvedValue({ id: "ii_1" });
  mocks.invoicesFinalize.mockResolvedValue({ id: "in_1" });
  mocks.invoicesPay.mockResolvedValue({ id: "in_1", status: "paid" });
  mocks.invoicesRetrieve.mockResolvedValue({ id: "in_1", status: "open" });
  mocks.invoicesVoid.mockResolvedValue({});
  mocks.invoicesDel.mockResolvedValue({});
  mocks.invoicePaymentsList.mockResolvedValue({
    data: [{ payment: { payment_intent: "pi_1" } }],
  });

  accountId = (await getOrCreateWalletAccount("user", userId)).id;
});

async function api(method: "GET" | "PUT", body?: unknown) {
  const res = await handle.app.inject({
    method,
    url: "/api/user/wallet/auto-topup",
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.statusCode,
    body: JSON.parse(res.body || "{}") as Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

async function webhook(type: string, object: unknown) {
  eventSeq += 1;
  mocks.constructEvent.mockReturnValue({
    id: `evt_${eventSeq}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/webhooks/stripe/",
    headers: {
      "stripe-signature": "t=1,v1=test",
      "content-type": "application/json",
    },
    payload: "{}",
  });
  expect(res.statusCode).toBe(200);
}

const paidInvoice = (id = "in_1", cents = 1000) => ({
  id,
  currency: "eur",
  customer: "cus_1",
  amount_due: cents,
  amount_paid: cents,
  amount_remaining: 0,
  status: "paid",
  created: Math.floor(Date.now() / 1000),
  metadata: {
    purpose: "wallet_topup",
    trigger: "auto",
    userId,
    creditMicro: (BigInt(cents) * 10_000n).toString(),
  },
});

async function row() {
  const [r] = await db
    .select()
    .from(walletAutoTopups)
    .where(eq(walletAutoTopups.accountId, accountId));
  return r;
}

const cardError = (code: string) =>
  new Stripe.errors.StripeCardError({
    type: "card_error",
    code,
    message: "declined",
  } as never);

describe("GET/PUT /api/user/wallet/auto-topup", () => {
  it("is off by default", async () => {
    const res = await api("GET");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      amountCents: null,
      lastTopupAt: null,
      disabledReason: null,
    });
  });

  it("requires a session", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/api/user/wallet/auto-topup",
    });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    config.wallet.minTopupCents - 100,
    config.wallet.maxTopupCents + 100,
  ])("refuses %i cents, outside the top-up bounds", async (amountCents) => {
    const res = await api("PUT", { enabled: true, amountCents });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("WAL_004");
    expect(await row()).toBeUndefined();
  });

  it("reuses the customer's default card and tops up a low balance", async () => {
    const res = await api("PUT", { enabled: true, amountCents: 2500 });
    expect(res.status).toBe(200);
    expect(res.body.setupUrl).toBeNull();
    expect(res.body.autoTopup).toMatchObject({
      enabled: true,
      amountCents: 2500,
    });

    await vi.waitFor(() => expect(mocks.invoicesPay).toHaveBeenCalledTimes(1));
    expect(mocks.invoicesCreate.mock.calls[0]![0]).toMatchObject({
      customer: "cus_1",
      collection_method: "charge_automatically",
      default_payment_method: "pm_default",
      metadata: {
        purpose: "wallet_topup",
        trigger: "auto",
        userId,
        creditMicro: "25000000",
      },
    });
    expect(mocks.invoiceItemsCreate.mock.calls[0]![0]).toMatchObject({
      amount: 2500,
      currency: "eur",
    });
    expect(mocks.invoicesPay.mock.calls[0]![1]).toMatchObject({
      off_session: true,
      payment_method: "pm_default",
    });
  });

  it("credits the wallet once the invoice is paid, and reports the date", async () => {
    await api("PUT", { enabled: true, amountCents: 1000 });
    await vi.waitFor(() => expect(mocks.invoicesPay).toHaveBeenCalled());

    await webhook("invoice.paid", paidInvoice());
    await webhook("invoice.paid", paidInvoice());

    const txs = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.accountId, accountId));
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ type: "topup", amount: 10_000_000n });
    expect(txs[0]!.metadata).toMatchObject({
      trigger: "auto",
      invoiceId: "in_1",
      paymentIntentId: "pi_1",
    });
    expect((await row())?.chargePending).toBe(false);

    const view = await api("GET");
    expect(view.body.enabled).toBe(true);
    expect(view.body.lastTopupAt).toBe(txs[0]!.createdAt.toISOString());
  });

  it("does not charge while the balance is above the threshold", async () => {
    await creditWallet({
      accountId,
      type: "grant",
      amount: 5_000_000n,
      idempotencyKey: "g1",
    });
    await api("PUT", { enabled: true, amountCents: 1000 });
    expect(await sweepAutoTopups()).toBe(0);
    expect(mocks.invoicesCreate).not.toHaveBeenCalled();
  });

  it("does not charge again while the first charge is not credited", async () => {
    await api("PUT", { enabled: true, amountCents: 1000 });
    await vi.waitFor(() => expect(mocks.invoicesPay).toHaveBeenCalledTimes(1));

    expect(await sweepAutoTopups()).toBe(0);
    await db
      .update(walletAutoTopups)
      .set({ lastAttemptAt: new Date(Date.now() - 10 * 60_000) });
    expect(await sweepAutoTopups()).toBe(0);
    expect(mocks.invoicesCreate).toHaveBeenCalledTimes(1);
  });

  it("triggers from a usage debit that leaves the balance low", async () => {
    await creditWallet({
      accountId,
      type: "grant",
      amount: 50_000_000n,
      idempotencyKey: "g1",
    });
    await api("PUT", { enabled: true, amountCents: 1000 });
    expect(mocks.invoicesCreate).not.toHaveBeenCalled();

    await recordUsage({
      accountId,
      amount: 49_500_000n,
      idempotencyKey: "u1",
    });
    await vi.waitFor(() => expect(mocks.invoicesPay).toHaveBeenCalledTimes(1));
  });

  it("opens a card setup when no card is on file, and activates on completion", async () => {
    mocks.customersRetrieve.mockResolvedValue({
      id: "cus_1",
      invoice_settings: { default_payment_method: null },
    });
    const res = await api("PUT", { enabled: true, amountCents: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.setupUrl).toBe("https://checkout.test/setup");
    expect(res.body.autoTopup.enabled).toBe(false);
    expect(mocks.sessionsCreate.mock.calls[0]![0]).toMatchObject({
      mode: "setup",
      currency: "eur",
      customer: "cus_1",
      metadata: {
        purpose: "wallet_auto_topup_setup",
        userId,
        amountCents: "5000",
      },
    });
    expect(mocks.invoicesCreate).not.toHaveBeenCalled();

    mocks.setupIntentsRetrieve.mockResolvedValue({
      status: "succeeded",
      payment_method: "pm_new",
    });
    await webhook("checkout.session.completed", {
      id: "cs_1",
      mode: "setup",
      setup_intent: "seti_1",
      metadata: {
        purpose: "wallet_auto_topup_setup",
        userId,
        amountCents: "5000",
      },
    });

    expect(await row()).toMatchObject({
      enabled: true,
      amountCents: 5000,
      stripePaymentMethodId: "pm_new",
    });
    await vi.waitFor(() => expect(mocks.invoicesPay).toHaveBeenCalledTimes(1));
  });

  it("turns the option off and forgets the card", async () => {
    await api("PUT", { enabled: true, amountCents: 1000 });
    await vi.waitFor(() => expect(mocks.invoicesPay).toHaveBeenCalled());

    const res = await api("PUT", { enabled: false });
    expect(res.body.autoTopup.enabled).toBe(false);
    expect(await row()).toMatchObject({
      enabled: false,
      stripePaymentMethodId: null,
      disabledReason: null,
    });
  });

  it.each([
    ["card_declined", "payment_failed"],
    ["authentication_required", "authentication_required"],
  ])(
    "turns the option off and e-mails the user after a %s failure",
    async (code, reason) => {
      mocks.invoicesPay.mockRejectedValue(cardError(code));
      await api("PUT", { enabled: true, amountCents: 1000 });

      await vi.waitFor(async () =>
        expect((await row())?.enabled).toBe(false),
      );
      expect(await row()).toMatchObject({
        stripePaymentMethodId: null,
        disabledReason: reason,
      });
      expect(mocks.invoicesVoid).toHaveBeenCalledWith("in_1");
      await vi.waitFor(() =>
        expect(handle.capture.messages).toHaveLength(1),
      );
      expect(handle.capture.messages[0]).toMatchObject({
        to: "payer@example.com",
        subject: "Automatic top-up turned off",
      });

      const view = await api("GET");
      expect(view.body.disabledReason).toBe(reason);
    },
  );

  it("asks for a new card after a failed charge instead of reusing the default one", async () => {
    mocks.invoicesPay.mockRejectedValue(cardError("card_declined"));
    await api("PUT", { enabled: true, amountCents: 1000 });
    await vi.waitFor(async () => expect((await row())?.enabled).toBe(false));

    const res = await api("PUT", { enabled: true, amountCents: 1000 });
    expect(res.body.setupUrl).toBe("https://checkout.test/setup");
  });

  it("turns the option off when the saved card is detached", async () => {
    await api("PUT", { enabled: true, amountCents: 1000 });
    await vi.waitFor(() => expect(mocks.invoicesPay).toHaveBeenCalled());

    await webhook("payment_method.detached", { id: "pm_default" });
    expect(await row()).toMatchObject({
      enabled: false,
      disabledReason: "payment_method_removed",
    });
  });
});
