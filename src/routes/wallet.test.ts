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
const { mockRequireSession, mockGetOrCreate, mockList } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockGetOrCreate: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../middleware.js", () => ({ requireSession: mockRequireSession }));
vi.mock("../services/wallet/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WalletModule>()),
  getOrCreateWalletAccount: mockGetOrCreate,
  listWalletTransactions: mockList,
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
