import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestApp } from "../tests/helpers/app.js";
import { ERR } from "../errors.js";

import type * as WalletModule from "../services/wallet/index.js";
const {
  mockRequireSession,
  mockGetSession,
  mockGetOrCreate,
  mockList,
  mockCheckout,
  mockOptions,
  mockStats,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockGetSession: vi.fn(),
  mockGetOrCreate: vi.fn(),
  mockList: vi.fn(),
  mockCheckout: vi.fn(),
  mockOptions: vi.fn(),
  mockStats: vi.fn(),
}));

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../middleware.js", () => ({
  requireSession: mockRequireSession,
  getRequestSession: mockGetSession,
}));
vi.mock("../services/wallet/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WalletModule>()),
  getOrCreateWalletAccount: mockGetOrCreate,
  listWalletTransactions: mockList,
  createTopupCheckout: mockCheckout,
  getTopupOptions: mockOptions,
  getUserSpendStats: mockStats,
}));

const { walletRoutes } = await import("./wallet.js");

const app = createTestApp();

beforeAll(async () => {
  await app.register(walletRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  mockRequireSession.mockReset().mockResolvedValue("user-1");
  mockGetOrCreate
    .mockReset()
    .mockResolvedValue({ id: "acc", balance: 42n, isUnlimited: true });
  mockList.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  mockGetSession
    .mockReset()
    .mockResolvedValue({ user: { id: "user-1", email: "u@example.com" } });
  mockStats.mockReset().mockResolvedValue({ days: 30, total: "0" });
  mockCheckout
    .mockReset()
    .mockResolvedValue({ url: "https://checkout.test/s" });
  mockOptions.mockReset().mockReturnValue({
    enabled: true,
    currency: "eur",
    minCents: 500,
    maxCents: 50000,
  });
});

function signedOut() {
  mockRequireSession.mockImplementation(
    async (
      _req: unknown,
      reply: {
        status: (n: number) => { send: (b: unknown) => Promise<unknown> };
      },
    ) => {
      await reply.status(401).send(ERR.AUTH_001().toJSON());
      return "";
    },
  );
}

describe("GET /", () => {
  it("returns the caller's own wallet", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(mockGetOrCreate).toHaveBeenCalledWith("user", "user-1");
    expect(res.json()).toEqual({
      balance: "42",
      isUnlimited: true,
      canSpend: true,
      currency: "eur",
    });
  });

  it("answers 401 without a session and reads no wallet", async () => {
    signedOut();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(401);
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });
});

describe("GET /transactions", () => {
  it("lists the caller's history with the parsed query", async () => {
    mockList.mockResolvedValue({ items: [{ id: "t" }], nextCursor: "next" });
    const res = await app.inject({
      method: "GET",
      url: "/transactions?limit=5&cursor=abc&type=usage",
    });
    expect(mockList).toHaveBeenCalledWith({
      accountId: "acc",
      limit: 5,
      cursor: "abc",
      type: "usage",
    });
    expect(res.json()).toEqual({ items: [{ id: "t" }], nextCursor: "next" });
  });

  it("answers 401 without a session", async () => {
    signedOut();
    const res = await app.inject({ method: "GET", url: "/transactions" });
    expect(res.statusCode).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it.each(["limit=0", "limit=201", "limit=abc", "type=bonus", "cursor="])(
    "rejects the query %s with 400",
    async (query) => {
      const res = await app.inject({
        method: "GET",
        url: `/transactions?${query}`,
      });
      expect(res.statusCode).toBe(400);
      expect(mockList).not.toHaveBeenCalled();
    },
  );
});

describe("GET /topup-options", () => {
  it("returns the online top-up options to a signed-in user", async () => {
    const res = await app.inject({ method: "GET", url: "/topup-options" });
    expect(res.json()).toEqual({
      enabled: true,
      currency: "eur",
      minCents: 500,
      maxCents: 50000,
    });
  });

  it("answers 401 without a session", async () => {
    signedOut();
    const res = await app.inject({ method: "GET", url: "/topup-options" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /checkout", () => {
  it("opens a checkout for the session user, never for a user named in the body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      payload: { amountCents: 1000, userId: "someone-else" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ url: "https://checkout.test/s" });
    expect(mockCheckout).toHaveBeenCalledWith({
      userId: "user-1",
      email: "u@example.com",
      amountCents: 1000,
    });
  });

  it("answers 401 without a session and opens nothing", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      payload: { amountCents: 1000 },
    });
    expect(res.statusCode).toBe(401);
    expect(mockCheckout).not.toHaveBeenCalled();
  });

  it("propagates the unconfigured-payment error", async () => {
    mockCheckout.mockRejectedValue(ERR.WAL_006());
    const res = await app.inject({
      method: "POST",
      url: "/checkout",
      payload: { amountCents: 1000 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("WAL_006");
  });

  it.each([
    ["a missing amount", {}],
    ["a decimal amount", { amountCents: 10.5 }],
    ["a string amount", { amountCents: "1000" }],
    ["a negative amount", { amountCents: -5 }],
    ["a zero amount", { amountCents: 0 }],
  ])("rejects %s before calling Stripe", async (_label, payload) => {
    const res = await app.inject({ method: "POST", url: "/checkout", payload });
    expect(res.statusCode).toBe(400);
    expect(mockCheckout).not.toHaveBeenCalled();
  });
});

describe("GET /stats", () => {
  it("returns the caller's spend over 30 days by default", async () => {
    mockStats.mockResolvedValue({ days: 30, total: "1700", calls: 3 });
    const res = await app.inject({ method: "GET", url: "/stats" });
    expect(mockStats).toHaveBeenCalledWith("acc", 30);
    expect(res.json()).toEqual({ days: 30, total: "1700", calls: 3 });
  });

  it("accepts a window of 1 to 90 days", async () => {
    await app.inject({ method: "GET", url: "/stats?days=7" });
    expect(mockStats).toHaveBeenCalledWith("acc", 7);
    await app.inject({ method: "GET", url: "/stats?days=90" });
    expect(mockStats).toHaveBeenCalledWith("acc", 90);
  });

  it.each(["days=0", "days=91", "days=abc", "days=1.5"])(
    "rejects %s",
    async (query) => {
      const res = await app.inject({ method: "GET", url: `/stats?${query}` });
      expect(res.statusCode).toBe(400);
      expect(mockStats).not.toHaveBeenCalled();
    },
  );

  it("answers 401 without a session", async () => {
    signedOut();
    const res = await app.inject({ method: "GET", url: "/stats" });
    expect(res.statusCode).toBe(401);
    expect(mockStats).not.toHaveBeenCalled();
  });
});
