import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestApp } from "../../tests/helpers/app.js";
import { ERR } from "../../errors.js";

import type * as WalletModule from "../../services/wallet/index.js";
const {
  mockGetSession,
  mockGetOrCreate,
  mockList,
  mockGrant,
  mockAdjust,
  mockSetUnlimited,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetOrCreate: vi.fn(),
  mockList: vi.fn(),
  mockGrant: vi.fn(),
  mockAdjust: vi.fn(),
  mockSetUnlimited: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({ db: {} }));
vi.mock("../../middleware.js", () => ({
  requireAdmin: vi.fn(async () => undefined),
  getRequestSession: mockGetSession,
}));
vi.mock("../../services/wallet/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WalletModule>()),
  getOrCreateWalletAccount: mockGetOrCreate,
  listWalletTransactions: mockList,
  grantCredit: mockGrant,
  adjustBalance: mockAdjust,
  setWalletUnlimited: mockSetUnlimited,
}));

const { adminWalletRoutes } = await import("./wallets.js");

const app = createTestApp();

beforeAll(async () => {
  await app.register(adminWalletRoutes);
  await app.ready();
});

afterAll(() => app.close());

const transaction = {
  id: "t1",
  type: "grant",
  amount: 100n,
  delta: 100n,
  balanceAfter: 100n,
  applicationId: null,
  metadata: {},
  createdAt: new Date("2026-10-09T10:00:00.000Z"),
};

function signInAs(role: string | null) {
  mockGetSession.mockResolvedValue(
    role ? { user: { id: "actor-1", role } } : null,
  );
}

beforeEach(() => {
  signInAs("superadmin");
  mockGetOrCreate
    .mockReset()
    .mockResolvedValue({ id: "acc", balance: 5n, isUnlimited: false });
  mockList.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  mockGrant.mockReset().mockResolvedValue({ transaction, replayed: false });
  mockAdjust.mockReset().mockResolvedValue({ transaction, replayed: false });
  mockSetUnlimited
    .mockReset()
    .mockResolvedValue({ id: "acc", balance: 5n, isUnlimited: true });
});

const grant = { amount: "100", idempotencyKey: "k", reason: "welcome" };

describe("read endpoints", () => {
  it("returns a user's wallet and history to any admin", async () => {
    signInAs("admin");
    const wallet = await app.inject({ method: "GET", url: "/users/u1" });
    expect(wallet.json()).toEqual({
      balance: "5",
      isUnlimited: false,
      currency: "eur",
    });
    const history = await app.inject({
      method: "GET",
      url: "/users/u1/transactions?limit=3",
    });
    expect(history.statusCode).toBe(200);
    expect(mockList).toHaveBeenCalledWith({ accountId: "acc", limit: 3 });
  });

  it("propagates an unknown user", async () => {
    mockGetOrCreate.mockRejectedValue(ERR.USR_001());
    const res = await app.inject({ method: "GET", url: "/users/nobody" });
    expect(res.statusCode).toBe(404);
  });
});

describe("write endpoints are superadmin-only", () => {
  const writes: Array<[string, string, string, unknown]> = [
    ["grant", "POST", "/users/u1/grants", grant],
    ["adjustment", "POST", "/users/u1/adjustments", { ...grant, amount: "-5" }],
    [
      "unlimited toggle",
      "PUT",
      "/users/u1/unlimited",
      { isUnlimited: true, reason: "r" },
    ],
  ];

  it.each(writes)(
    "refuses an admin on %s",
    async (_name, method, url, payload) => {
      signInAs("admin");
      const res = await app.inject({
        method: method as "POST" | "PUT",
        url,
        payload: payload as object,
      });
      expect(res.statusCode).toBe(403);
      expect(mockGrant).not.toHaveBeenCalled();
      expect(mockAdjust).not.toHaveBeenCalled();
      expect(mockSetUnlimited).not.toHaveBeenCalled();
    },
  );

  it.each(writes)(
    "refuses a missing session on %s",
    async (_name, method, url, payload) => {
      signInAs(null);
      const res = await app.inject({
        method: method as "POST" | "PUT",
        url,
        payload: payload as object,
      });
      expect(res.statusCode).toBe(401);
    },
  );
});

describe("POST /users/:userId/grants", () => {
  it("credits with the actor from the session, never from the body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/users/u1/grants",
      payload: { ...grant, actorId: "forged" },
    });
    expect(mockGrant).toHaveBeenCalledWith({
      accountId: "acc",
      amount: 100n,
      idempotencyKey: "k",
      actorId: "actor-1",
      reason: "welcome",
    });
    expect(res.statusCode).toBe(201);
    expect(
      res.json<{ transaction: { amount: string } }>().transaction.amount,
    ).toBe("100");
  });

  it("answers 200 for a replay", async () => {
    mockGrant.mockResolvedValue({ transaction, replayed: true });
    const res = await app.inject({
      method: "POST",
      url: "/users/u1/grants",
      payload: grant,
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ["no reason", { amount: "5", idempotencyKey: "k" }],
    ["a blank reason", { ...grant, reason: "   " }],
    ["an over-long reason", { ...grant, reason: "x".repeat(501) }],
    ["a zero amount", { ...grant, amount: "0" }],
    ["a negative amount", { ...grant, amount: "-5" }],
  ])("rejects %s", async (_label, payload) => {
    const res = await app.inject({
      method: "POST",
      url: "/users/u1/grants",
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(mockGrant).not.toHaveBeenCalled();
  });
});

describe("POST /users/:userId/adjustments", () => {
  it("accepts a signed amount", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/users/u1/adjustments",
      payload: { ...grant, amount: "-40" },
    });
    expect(res.statusCode).toBe(201);
    expect(mockAdjust).toHaveBeenCalledWith(
      expect.objectContaining({ amount: -40n, actorId: "actor-1" }),
    );
  });

  it("answers 200 for a replay", async () => {
    mockAdjust.mockResolvedValue({ transaction, replayed: true });
    const res = await app.inject({
      method: "POST",
      url: "/users/u1/adjustments",
      payload: grant,
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a zero adjustment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/users/u1/adjustments",
      payload: { ...grant, amount: "0" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PUT /users/:userId/unlimited", () => {
  it("toggles the flag on behalf of the session user", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/users/u1/unlimited",
      payload: { isUnlimited: true, reason: "staff" },
    });
    expect(mockSetUnlimited).toHaveBeenCalledWith({
      accountId: "acc",
      isUnlimited: true,
      actorId: "actor-1",
      reason: "staff",
    });
    expect(res.json()).toEqual({
      balance: "5",
      isUnlimited: true,
      currency: "eur",
    });
  });

  it.each([
    ["a non-boolean flag", { isUnlimited: "yes", reason: "r" }],
    ["no reason", { isUnlimited: true }],
  ])("rejects %s", async (_label, payload) => {
    const res = await app.inject({
      method: "PUT",
      url: "/users/u1/unlimited",
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(mockSetUnlimited).not.toHaveBeenCalled();
  });
});
