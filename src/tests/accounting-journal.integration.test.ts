import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { accountingRoutes } from "../routes/admin/accounting.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import {
  applications,
  subscriptionPlans,
  userSubscriptionEvents,
  walletAccountEvents,
  walletTransactions,
} from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";
import { makeSuperadminSession, makeUserSession } from "./helpers/auth.js";
import { getOrCreateWalletAccount } from "../services/wallet/index.js";
import { auth } from "../auth.js";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const app = createTestApp();

beforeAll(async () => {
  await app.register(accountingRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
});

type SessionLike =
  ReturnType<typeof auth.api.getSession> extends Promise<infer T> ? T : never;

function asAdmin() {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeSuperadminSession("admin-1") as unknown as SessionLike,
  );
}

interface Entry {
  id: string;
  kind: string;
  createdAt: string;
  owner: { type: string; id: string; name: string | null };
  actor: { id: string; name: string | null } | null;
  source: string | null;
  application: { name: string } | null;
  amount: string | null;
  fromPlan: string | null;
  toPlan: string | null;
  reason: string | null;
  reference: string | null;
}

interface JournalBody {
  entries: Entry[];
  total: number;
  page: number;
  limit: number;
}

async function journal(query = ""): Promise<{ status: number; body: JournalBody }> {
  const res = await app.inject({
    method: "GET",
    url: `/journal${query}`,
  });
  return { status: res.statusCode, body: res.json<JournalBody>() };
}

async function seedUser(id: string, name: string) {
  await db.insert(userTable).values({
    id,
    name,
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

const at = (iso: string) => new Date(iso);

/** Two users, one admin, an app with two plans, and one entry per source. */
async function seed() {
  await seedUser("admin-1", "Ada Admin");
  await seedUser("alice", "Alice");
  await seedUser("bob", "Bob");
  const [app1] = await db
    .insert(applications)
    .values({ name: "Chat", slug: "chat", isActive: true })
    .returning();
  const [free] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: app1!.id, name: "free", features: {} })
    .returning();
  const [pro] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: app1!.id, name: "pro", features: {} })
    .returning();

  const aliceWallet = await getOrCreateWalletAccount("user", "alice");
  const bobWallet = await getOrCreateWalletAccount("user", "bob");

  await db.insert(walletTransactions).values([
    {
      accountId: aliceWallet.id,
      type: "topup",
      amount: 5_000_000n,
      delta: 5_000_000n,
      balanceAfter: 5_000_000n,
      idempotencyKey: "k-topup",
      metadata: { source: "manual", reference: "INV-1", actorId: "admin-1" },
      createdAt: at("2026-03-01T10:00:00Z"),
    },
    {
      accountId: bobWallet.id,
      type: "grant",
      amount: 2_000_000n,
      delta: 2_000_000n,
      balanceAfter: 2_000_000n,
      idempotencyKey: "k-grant",
      metadata: { actorId: "admin-1", reason: "Compensation" },
      createdAt: at("2026-03-03T10:00:00Z"),
    },
    {
      accountId: aliceWallet.id,
      type: "usage",
      amount: -1_000_000n,
      delta: -1_000_000n,
      balanceAfter: 4_000_000n,
      idempotencyKey: "k-usage",
      metadata: {},
      createdAt: at("2026-03-04T10:00:00Z"),
    },
  ]);
  await db.insert(walletAccountEvents).values({
    accountId: aliceWallet.id,
    actorUserId: "admin-1",
    action: "unlimited_enabled",
    details: { reason: "VIP" },
    createdAt: at("2026-03-02T10:00:00Z"),
  });
  await db.insert(userSubscriptionEvents).values({
    userId: "bob",
    applicationId: app1!.id,
    actorUserId: "admin-1",
    source: "admin",
    action: "changed",
    fromPlanId: free!.id,
    toPlanId: pro!.id,
    reason: "Upgrade",
    createdAt: at("2026-03-05T10:00:00Z"),
  });
  return { appId: app1!.id };
}

describe("GET /journal", () => {
  it("401 without a session, 403 for a regular user", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValueOnce(null);
    expect((await journal()).status).toBe(401);

    vi.spyOn(auth.api, "getSession").mockResolvedValueOnce(
      makeUserSession() as unknown as SessionLike,
    );
    expect((await journal()).status).toBe(403);
  });

  it("merges the three sources newest first and leaves usage out", async () => {
    await seed();
    asAdmin();
    const { status, body } = await journal();
    expect(status).toBe(200);
    expect(body.total).toBe(4);
    expect(body.entries.map((e) => e.kind)).toEqual([
      "subscription_changed",
      "grant",
      "unlimited_enabled",
      "topup",
    ]);
  });

  it("describes each entry with its owner, actor and details", async () => {
    await seed();
    asAdmin();
    const { body } = await journal();
    const [change, grant, , topup] = body.entries;

    expect(change).toMatchObject({
      owner: { id: "bob", name: "Bob" },
      actor: { id: "admin-1", name: "Ada Admin" },
      source: "admin",
      fromPlan: "free",
      toPlan: "pro",
      reason: "Upgrade",
      application: { name: "Chat" },
      amount: null,
    });
    expect(grant).toMatchObject({
      amount: "2000000",
      reason: "Compensation",
      actor: { id: "admin-1" },
    });
    expect(topup).toMatchObject({
      source: "manual",
      reference: "INV-1",
      amount: "5000000",
    });
  });

  it("keeps an unknown actor id instead of dropping the attribution", async () => {
    const { appId } = await seed();
    await db.insert(userSubscriptionEvents).values({
      userId: "bob",
      applicationId: appId,
      actorUserId: "deleted-admin",
      source: "admin",
      action: "removed",
      createdAt: at("2026-03-06T10:00:00Z"),
    });
    asAdmin();
    const { body } = await journal();
    expect(body.entries[0]?.kind).toBe("subscription_removed");
    expect(body.entries[0]?.actor).toMatchObject({
      id: "deleted-admin",
      name: null,
    });
  });

  it("filters by user across every source", async () => {
    await seed();
    asAdmin();
    const alice = await journal("?userId=alice");
    expect(alice.body.entries.map((e) => e.kind)).toEqual([
      "unlimited_enabled",
      "topup",
    ]);
    expect(alice.body.total).toBe(2);

    const bob = await journal("?userId=bob");
    expect(bob.body.entries.map((e) => e.kind)).toEqual([
      "subscription_changed",
      "grant",
    ]);
  });

  it("filters by kind", async () => {
    await seed();
    asAdmin();
    const grants = await journal("?kind=grant");
    expect(grants.body.entries.map((e) => e.kind)).toEqual(["grant"]);
    expect(grants.body.total).toBe(1);

    const unlimited = await journal("?kind=unlimited_enabled");
    expect(unlimited.body.total).toBe(1);

    const none = await journal("?kind=refund");
    expect(none.body).toMatchObject({ entries: [], total: 0 });
  });

  it("filters by application: account events have none and drop out", async () => {
    const { appId } = await seed();
    asAdmin();
    const { body } = await journal(`?applicationId=${appId}`);
    expect(body.entries.map((e) => e.kind)).toEqual(["subscription_changed"]);
  });

  it("filters by date range, end exclusive", async () => {
    await seed();
    asAdmin();
    const { body } = await journal(
      "?from=2026-03-02T00:00:00Z&to=2026-03-03T10:00:00Z",
    );
    expect(body.entries.map((e) => e.kind)).toEqual(["unlimited_enabled"]);
    expect(body.total).toBe(1);
  });

  it("paginates the merged list with a stable total", async () => {
    await seed();
    asAdmin();
    const first = await journal("?limit=3&page=1");
    const second = await journal("?limit=3&page=2");
    expect(first.body.total).toBe(4);
    expect(first.body.entries).toHaveLength(3);
    expect(second.body.entries.map((e) => e.kind)).toEqual(["topup"]);
  });

  it("400 on an inverted range, an unknown kind or a too deep page", async () => {
    asAdmin();
    expect(
      (await journal("?from=2026-03-05T00:00:00Z&to=2026-03-01T00:00:00Z"))
        .status,
    ).toBe(400);
    expect((await journal("?kind=usage")).status).toBe(400);
    expect((await journal("?limit=100&page=51")).status).toBe(400);
    expect((await journal("?applicationId=not-a-uuid")).status).toBe(400);
  });
});
