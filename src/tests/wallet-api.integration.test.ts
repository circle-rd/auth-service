import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import {
  applications,
  walletAccountEvents,
  walletAccounts,
  walletTransactions,
} from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";
import {
  creditWallet,
  getOrCreateWalletAccount,
} from "../services/wallet/index.js";

let handle: AuthServerHandle;
let superadmin: Actor;
let admin: Actor;
let customer: Actor;
let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  handle = await makeAuthServer();
  await cleanDb();
  // Sign-up and sign-in are rate limited: create the actors once and only
  // reset wallet and application state between tests.
  superadmin = await signInAs("root@example.com", "superadmin");
  admin = await signInAs("admin@example.com", "admin");
  customer = await signInAs("customer@example.com", "user");
  alice = await signInAs("alice@example.com", "user");
  bob = await signInAs("bob@example.com", "user");
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE
    wallet_account_events, wallet_transactions, wallet_accounts,
    user_applications, applications,
    oauth_access_token, oauth_refresh_token, oauth_consent,
    oauth_client_resource, oauth_resource, oauth_client
    RESTART IDENTITY CASCADE`);
});

// ── Helpers ────────────────────────────────────────────────────────────────

interface Actor {
  id: string;
  cookie: string;
}

async function signInAs(
  email: string,
  role: "user" | "admin" | "superadmin",
): Promise<Actor> {
  const { cookie } = await signUpAndSignIn(handle, {
    email,
    password: "Password123!",
    name: email,
  });
  await db.update(userTable).set({ role }).where(eq(userTable.email, email));
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email));
  return { id: row!.id, cookie };
}

async function api(
  method: "GET" | "POST" | "PUT" | "PATCH",
  url: string,
  opts: { cookie?: string; bearer?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await handle.app.inject({
    method,
    url,
    headers,
    payload: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return {
    status: res.statusCode,
    body: JSON.parse(res.body || "{}") as Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

interface WalletClient {
  id: string;
  slug: string;
  secret: string;
}

/** Create the private gateway application and grant it the given machine scopes. */
async function createWalletClient(
  scopes: string[],
  url?: string,
): Promise<WalletClient> {
  const created = await api("POST", "/api/admin/applications", {
    cookie: superadmin.cookie,
    body: { name: "Wallet client", slug: "wallet-client", url },
  });
  expect(created.status).toBe(201);
  const id = created.body.application.id as string;
  const granted = await api("PUT", `/api/admin/applications/${id}/machine-scopes`, {
    cookie: superadmin.cookie,
    body: { scopes },
  });
  expect(granted.status).toBe(200);
  return { id, slug: "wallet-client", secret: created.body.clientSecret as string };
}

async function machineToken(
  client: WalletClient,
  scope: string,
  resource?: string,
): Promise<string> {
  const form = new URLSearchParams({ grant_type: "client_credentials", scope });
  if (resource) form.set("resource", resource);
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/auth/oauth2/token",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization:
        "Basic " + Buffer.from(`${client.slug}:${client.secret}`).toString("base64"),
    },
    payload: form.toString(),
  });
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as { access_token: string }).access_token;
}

async function walletOf(userId: string) {
  return getOrCreateWalletAccount("user", userId);
}

// ── Machine scopes administration ──────────────────────────────────────────

describe("application machine scopes", () => {
  it("lets a superadmin set scopes and an admin read them", async () => {
    const client = await createWalletClient(["wallet:read", "wallet:debit", "wallet:read"]);

    const read = await api("GET", `/api/admin/applications/${client.id}/machine-scopes`, {
      cookie: admin.cookie,
    });
    expect(read.status).toBe(200);
    expect(read.body.scopes).toEqual(["wallet:read", "wallet:debit"]);
  });

  it("refuses scope changes from a plain admin", async () => {
    const client = await createWalletClient(["m2m"]);
    const res = await api("PUT", `/api/admin/applications/${client.id}/machine-scopes`, {
      cookie: admin.cookie,
      body: { scopes: ["wallet:debit"] },
    });
    expect(res.status).toBe(403);
  });

  it("rejects unknown scopes, public applications and unknown applications", async () => {
    
    const client = await createWalletClient(["m2m"]);
    const unknownScope = await api("PUT", `/api/admin/applications/${client.id}/machine-scopes`, {
      cookie: superadmin.cookie,
      body: { scopes: ["wallet:everything"] },
    });
    expect(unknownScope.status).toBe(400);

    const pub = await api("POST", "/api/admin/applications", {
      cookie: superadmin.cookie,
      body: { name: "Pub", slug: "pub", isPublic: true },
    });
    const forPublic = await api(
      "PUT",
      `/api/admin/applications/${pub.body.application.id}/machine-scopes`,
      { cookie: superadmin.cookie, body: { scopes: ["wallet:read"] } },
    );
    expect(forPublic.status).toBe(400);

    const missing = await api(
      "GET",
      "/api/admin/applications/00000000-0000-0000-0000-000000000000/machine-scopes",
      { cookie: superadmin.cookie },
    );
    expect(missing.status).toBe(404);
  });
});

// ── Internal API ───────────────────────────────────────────────────────────

describe("internal wallet API", () => {
  async function setup(scopes = ["wallet:debit", "wallet:read"], url?: string) {
    const client = await createWalletClient(scopes, url);
    const token = await machineToken(client, scopes.join(" "), url);
    return { superadmin, customer, client, token };
  }

  const usageUrl = (userId: string) => `/api/internal/wallet/users/${userId}/usage`;
  const balanceUrl = (userId: string) => `/api/internal/wallet/users/${userId}`;

  it("returns an empty balance for a user who never topped up", async () => {
    const { customer, token } = await setup();
    const res = await api("GET", balanceUrl(customer.id), { bearer: token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ balance: "0", isUnlimited: false, currency: "eur" });
  });

  it("accepts a JWT machine token as well as an opaque one", async () => {
    const { customer, token } = await setup(
      ["wallet:read"],
      "https://wallet-client.example.com",
    );
    expect(token.split(".")).toHaveLength(3);
    const res = await api("GET", balanceUrl(customer.id), { bearer: token });
    expect(res.status).toBe(200);
  });

  it("rejects an unknown user", async () => {
    const { token } = await setup();
    const res = await api("GET", balanceUrl("nobody"), { bearer: token });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("USR_001");
  });

  it("debits usage, attributes it to the application and replays safely", async () => {
    const { customer, token } = await setup();
    await creditWallet({
      accountId: (await walletOf(customer.id)).id,
      type: "topup",
      amount: 10_000n,
      idempotencyKey: "seed",
    });

    const body = {
      amount: "2500",
      idempotencyKey: "litellm-req-1",
      applicationSlug: "wallet-client",
      metadata: { model: "gpt-x", promptTokens: 120, tool: null },
    };
    const first = await api("POST", usageUrl(customer.id), { bearer: token, body });
    expect(first.status).toBe(201);
    expect(first.body.replayed).toBe(false);
    expect(first.body.transaction).toMatchObject({
      type: "usage",
      amount: "-2500",
      delta: "-2500",
      balanceAfter: "7500",
      metadata: { model: "gpt-x", promptTokens: 120, tool: null, applicationSlug: "wallet-client" },
    });
    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.slug, "wallet-client"));
    expect(first.body.transaction.applicationId).toBe(app!.id);

    const replay = await api("POST", usageUrl(customer.id), { bearer: token, body });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.transaction.id).toBe(first.body.transaction.id);

    const balance = await api("GET", balanceUrl(customer.id), { bearer: token });
    expect(balance.body.balance).toBe("7500");
  });

  it("keeps a usage debit whose application no longer exists", async () => {
    const { customer, token } = await setup();
    await creditWallet({
      accountId: (await walletOf(customer.id)).id,
      type: "topup",
      amount: 100n,
      idempotencyKey: "seed",
    });
    const res = await api("POST", usageUrl(customer.id), {
      bearer: token,
      body: { amount: "10", idempotencyKey: "k", applicationSlug: "deleted-app" },
    });
    expect(res.status).toBe(201);
    expect(res.body.transaction.applicationId).toBeNull();
    expect(res.body.transaction.metadata.applicationSlug).toBe("deleted-app");
  });

  it("answers 402 when the balance is insufficient and leaves it untouched", async () => {
    const { customer, token } = await setup();
    await creditWallet({
      accountId: (await walletOf(customer.id)).id,
      type: "topup",
      amount: 100n,
      idempotencyKey: "seed",
    });
    const res = await api("POST", usageUrl(customer.id), {
      bearer: token,
      body: { amount: "101", idempotencyKey: "k" },
    });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({
      code: "WAL_002",
      details: { balance: "100", required: "101" },
    });
    expect((await walletOf(customer.id)).balance).toBe(100n);
  });

  it("answers 409 when a key is reused with another amount", async () => {
    const { customer, token } = await setup();
    await creditWallet({
      accountId: (await walletOf(customer.id)).id,
      type: "topup",
      amount: 1_000n,
      idempotencyKey: "seed",
    });
    await api("POST", usageUrl(customer.id), {
      bearer: token,
      body: { amount: "10", idempotencyKey: "k" },
    });
    const res = await api("POST", usageUrl(customer.id), {
      bearer: token,
      body: { amount: "11", idempotencyKey: "k" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("WAL_003");
  });

  it.each([
    ["zero", { amount: "0", idempotencyKey: "k" }],
    ["negative", { amount: "-5", idempotencyKey: "k" }],
    ["decimal", { amount: "1.5", idempotencyKey: "k" }],
    ["json number", { amount: 5, idempotencyKey: "k" }],
    ["above the ledger maximum", { amount: "1000000000000000001", idempotencyKey: "k" }],
    ["missing key", { amount: "5" }],
    ["nested metadata", { amount: "5", idempotencyKey: "k", metadata: { a: { b: 1 } } }],
  ])("rejects a usage body with a %s", async (_label, body) => {
    const { customer, token } = await setup();
    const res = await api("POST", usageUrl(customer.id), { bearer: token, body });
    expect(res.status).toBe(400);
  });

  it("rejects missing, malformed and unknown credentials with 401", async () => {
    const { customer } = await setup();
    expect((await api("GET", balanceUrl(customer.id))).status).toBe(401);
    expect((await api("GET", balanceUrl(customer.id), { bearer: "garbage" })).status).toBe(401);
    expect(
      (await api("GET", balanceUrl(customer.id), { bearer: "a.b.c" })).status,
    ).toBe(401);
  });

  it("rejects a session cookie: the internal API is machine-only", async () => {
    const { superadmin, customer } = await setup();
    const res = await api("GET", balanceUrl(customer.id), { cookie: superadmin.cookie });
    expect(res.status).toBe(401);
  });

  it("enforces scopes per route", async () => {
    const { customer, client } = await setup();
    const readOnly = await machineToken(client, "wallet:read");
    expect((await api("GET", balanceUrl(customer.id), { bearer: readOnly })).status).toBe(200);
    const debit = await api("POST", usageUrl(customer.id), {
      bearer: readOnly,
      body: { amount: "1", idempotencyKey: "k" },
    });
    expect(debit.status).toBe(403);

    const debitOnly = await machineToken(client, "wallet:debit");
    expect((await api("GET", balanceUrl(customer.id), { bearer: debitOnly })).status).toBe(403);
  });

  it("refuses a client credentials token that only carries the generic m2m scope", async () => {
    const { customer, client } = await setup(["m2m", "wallet:read"]);
    const m2m = await machineToken(client, "m2m");
    const res = await api("GET", balanceUrl(customer.id), { bearer: m2m });
    expect(res.status).toBe(403);
  });

  it("takes a scope removal into account immediately, even for a live token", async () => {
    const { superadmin, customer, client, token } = await setup(["wallet:read"]);
    expect((await api("GET", balanceUrl(customer.id), { bearer: token })).status).toBe(200);
    await api("PUT", `/api/admin/applications/${client.id}/machine-scopes`, {
      cookie: superadmin.cookie,
      body: { scopes: ["m2m"] },
    });
    expect((await api("GET", balanceUrl(customer.id), { bearer: token })).status).toBe(401);
  });

  it("takes a scope removal into account immediately for a stateless JWT", async () => {
    const { customer, client } = await setup(
      ["wallet:read"],
      "https://wallet-client.example.com",
    );
    const jwt = await machineToken(
      client,
      "wallet:read",
      "https://wallet-client.example.com",
    );
    expect(
      (await api("GET", balanceUrl(customer.id), { bearer: jwt })).status,
    ).toBe(200);
    await api("PUT", `/api/admin/applications/${client.id}/machine-scopes`, {
      cookie: superadmin.cookie,
      body: { scopes: ["m2m"] },
    });
    expect(
      (await api("GET", balanceUrl(customer.id), { bearer: jwt })).status,
    ).toBe(403);
  });

  it("stops serving a disabled client", async () => {
    const { superadmin, customer, client } = await setup(
      ["wallet:read"],
      "https://wallet-client.example.com",
    );
    const jwt = await machineToken(client, "wallet:read", "https://wallet-client.example.com");
    expect((await api("GET", balanceUrl(customer.id), { bearer: jwt })).status).toBe(200);
    await api("PATCH", `/api/admin/applications/${client.id}`, {
      cookie: superadmin.cookie,
      body: { isActive: false },
    });
    expect((await api("GET", balanceUrl(customer.id), { bearer: jwt })).status).toBe(403);
  });

  it("records usage without deducting it on an unlimited account", async () => {
    const { customer, token } = await setup();
    const account = await walletOf(customer.id);
    await db
      .update(walletAccounts)
      .set({ isUnlimited: true })
      .where(eq(walletAccounts.id, account.id));
    const res = await api("POST", usageUrl(customer.id), {
      bearer: token,
      body: { amount: "999999", idempotencyKey: "k" },
    });
    expect(res.status).toBe(201);
    expect(res.body.transaction).toMatchObject({ amount: "-999999", delta: "0" });
    expect((await walletOf(customer.id)).balance).toBe(0n);
  });
});

// ── User API ───────────────────────────────────────────────────────────────

describe("user wallet API", () => {
  it("requires a session", async () => {
    expect((await api("GET", "/api/user/wallet")).status).toBe(401);
    expect((await api("GET", "/api/user/wallet/transactions")).status).toBe(401);
  });

  it("shows the signed-in user's own balance", async () => {
    await creditWallet({
      accountId: (await walletOf(alice.id)).id,
      type: "topup",
      amount: 4_200n,
      idempotencyKey: "seed",
    });
    expect((await api("GET", "/api/user/wallet", { cookie: alice.cookie })).body).toEqual({
      balance: "4200",
      isUnlimited: false,
      currency: "eur",
    });
    expect((await api("GET", "/api/user/wallet", { cookie: bob.cookie })).body.balance).toBe("0");
  });

  it("pages the history newest first without gaps or repeats", async () => {
    const accountId = (await walletOf(alice.id)).id;
    for (let i = 1; i <= 5; i += 1) {
      await creditWallet({ accountId, type: "topup", amount: BigInt(i), idempotencyKey: `k${i}` });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const query = `limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await api("GET", `/api/user/wallet/transactions?${query}`, { cookie: alice.cookie });
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((t: { amount: string }) => t.amount));
      cursor = res.body.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual(["5", "4", "3", "2", "1"]);
  });

  it("filters the history by type and never exposes idempotency keys", async () => {
    const accountId = (await walletOf(alice.id)).id;
    await creditWallet({ accountId, type: "topup", amount: 50n, idempotencyKey: "secret-key-1" });
    await creditWallet({ accountId, type: "grant", amount: 5n, idempotencyKey: "secret-key-2" });
    const res = await api("GET", "/api/user/wallet/transactions?type=grant", { cookie: alice.cookie });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].type).toBe("grant");
    expect(JSON.stringify(res.body)).not.toContain("secret-key");
  });

  it.each([
    ["an invalid cursor", "cursor=not-a-cursor", "WAL_005"],
    ["a limit of zero", "limit=0", "APP_001"],
    ["a limit above the maximum", "limit=201", "APP_001"],
    ["an unknown type", "type=bonus", "APP_001"],
  ])("rejects %s", async (_label, query, code) => {
    const res = await api("GET", `/api/user/wallet/transactions?${query}`, { cookie: alice.cookie });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });
});

// ── Admin API ──────────────────────────────────────────────────────────────

describe("admin wallet API", () => {
  async function actors() {
    return { superadmin, admin, customer };
  }
  const walletUrl = (userId: string, suffix = "") => `/api/admin/wallets/users/${userId}${suffix}`;

  it("refuses regular users and anonymous callers", async () => {
    const { customer } = await actors();
    expect((await api("GET", walletUrl(customer.id))).status).toBe(401);
    expect((await api("GET", walletUrl(customer.id), { cookie: customer.cookie })).status).toBe(403);
  });

  it("lets an admin read but not change balances", async () => {
    const { admin, customer } = await actors();
    expect((await api("GET", walletUrl(customer.id), { cookie: admin.cookie })).status).toBe(200);
    expect(
      (await api("GET", walletUrl(customer.id, "/transactions"), { cookie: admin.cookie })).status,
    ).toBe(200);
    const body = { amount: "100", idempotencyKey: "k", reason: "test" };
    expect(
      (await api("POST", walletUrl(customer.id, "/grants"), { cookie: admin.cookie, body })).status,
    ).toBe(403);
    expect(
      (await api("POST", walletUrl(customer.id, "/adjustments"), { cookie: admin.cookie, body })).status,
    ).toBe(403);
    expect(
      (
        await api("PUT", walletUrl(customer.id, "/unlimited"), {
          cookie: admin.cookie,
          body: { isUnlimited: true, reason: "test" },
        })
      ).status,
    ).toBe(403);
    expect((await walletOf(customer.id)).balance).toBe(0n);
  });

  it("grants credit with the actor and reason in the ledger, replay-safe", async () => {
    const { superadmin, customer } = await actors();
    const body = { amount: "5000000", idempotencyKey: "grant-1", reason: "welcome credit" };
    const first = await api("POST", walletUrl(customer.id, "/grants"), { cookie: superadmin.cookie, body });
    expect(first.status).toBe(201);
    expect(first.body.transaction).toMatchObject({
      type: "grant",
      amount: "5000000",
      balanceAfter: "5000000",
      metadata: { actorId: superadmin.id, reason: "welcome credit" },
    });
    const replay = await api("POST", walletUrl(customer.id, "/grants"), { cookie: superadmin.cookie, body });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect((await walletOf(customer.id)).balance).toBe(5_000_000n);
  });

  it("applies signed adjustments and refuses to overdraw", async () => {
    const { superadmin, customer } = await actors();
    await api("POST", walletUrl(customer.id, "/grants"), {
      cookie: superadmin.cookie,
      body: { amount: "1000", idempotencyKey: "g", reason: "seed" },
    });
    const down = await api("POST", walletUrl(customer.id, "/adjustments"), {
      cookie: superadmin.cookie,
      body: { amount: "-400", idempotencyKey: "a1", reason: "correction" },
    });
    expect(down.status).toBe(201);
    expect(down.body.transaction).toMatchObject({ type: "adjust", amount: "-400", balanceAfter: "600" });
    const up = await api("POST", walletUrl(customer.id, "/adjustments"), {
      cookie: superadmin.cookie,
      body: { amount: "50", idempotencyKey: "a2", reason: "correction" },
    });
    expect(up.body.transaction.balanceAfter).toBe("650");
    const tooMuch = await api("POST", walletUrl(customer.id, "/adjustments"), {
      cookie: superadmin.cookie,
      body: { amount: "-651", idempotencyKey: "a3", reason: "correction" },
    });
    expect(tooMuch.status).toBe(402);
    expect((await walletOf(customer.id)).balance).toBe(650n);
  });

  it.each([
    ["a missing reason", { amount: "5", idempotencyKey: "k" }],
    ["a blank reason", { amount: "5", idempotencyKey: "k", reason: "   " }],
    ["a zero amount", { amount: "0", idempotencyKey: "k", reason: "r" }],
    ["a negative grant", { amount: "-5", idempotencyKey: "k", reason: "r" }],
  ])("rejects a grant with %s", async (_label, body) => {
    const { superadmin, customer } = await actors();
    const res = await api("POST", walletUrl(customer.id, "/grants"), { cookie: superadmin.cookie, body });
    expect(res.status).toBe(400);
  });

  it("rejects a zero adjustment", async () => {
    const { superadmin, customer } = await actors();
    const res = await api("POST", walletUrl(customer.id, "/adjustments"), {
      cookie: superadmin.cookie,
      body: { amount: "0", idempotencyKey: "k", reason: "r" },
    });
    expect(res.status).toBe(400);
  });

  it("toggles unlimited access and audits only real changes", async () => {
    const { superadmin, customer } = await actors();
    const enable = { isUnlimited: true, reason: "staff account" };
    const first = await api("PUT", walletUrl(customer.id, "/unlimited"), { cookie: superadmin.cookie, body: enable });
    expect(first.status).toBe(200);
    expect(first.body.isUnlimited).toBe(true);
    await api("PUT", walletUrl(customer.id, "/unlimited"), { cookie: superadmin.cookie, body: enable });
    await api("PUT", walletUrl(customer.id, "/unlimited"), {
      cookie: superadmin.cookie,
      body: { isUnlimited: false, reason: "left the company" },
    });

    const events = await db
      .select({
        action: walletAccountEvents.action,
        actorUserId: walletAccountEvents.actorUserId,
        details: walletAccountEvents.details,
      })
      .from(walletAccountEvents)
      .orderBy(walletAccountEvents.createdAt);
    expect(events).toEqual([
      { action: "unlimited_enabled", actorUserId: superadmin.id, details: { reason: "staff account" } },
      { action: "unlimited_disabled", actorUserId: superadmin.id, details: { reason: "left the company" } },
    ]);
  });

  it("answers 404 for an unknown user", async () => {
    const { superadmin } = await actors();
    const res = await api("GET", walletUrl("nobody"), { cookie: superadmin.cookie });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("USR_001");
  });

  it("keeps the ledger append-only: no wallet route deletes or edits rows", async () => {
    const { superadmin, customer } = await actors();
    await api("POST", walletUrl(customer.id, "/grants"), {
      cookie: superadmin.cookie,
      body: { amount: "10", idempotencyKey: "g", reason: "r" },
    });
    for (const method of ["PATCH", "DELETE"] as const) {
      const res = await handle.app.inject({
        method,
        url: walletUrl(customer.id, "/transactions"),
        headers: { cookie: superadmin.cookie },
      });
      expect(res.statusCode).toBe(404);
    }
    const rows = await db.select({ id: walletTransactions.id }).from(walletTransactions);
    expect(rows).toHaveLength(1);
  });
});
