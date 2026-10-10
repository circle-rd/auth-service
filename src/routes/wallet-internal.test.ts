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
const { mockRequireScope, mockGetOrCreate, mockRecordUsage } = vi.hoisted(
  () => ({
    mockRequireScope: vi.fn(),
    mockGetOrCreate: vi.fn(),
    mockRecordUsage: vi.fn(),
  }),
);

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/machine-auth.js", () => ({
  requireMachineScope: mockRequireScope,
}));
vi.mock("../services/wallet/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WalletModule>()),
  getOrCreateWalletAccount: mockGetOrCreate,
  recordUsage: mockRecordUsage,
}));

const { walletInternalRoutes } = await import("./wallet-internal.js");

const app = createTestApp();

beforeAll(async () => {
  await app.register(walletInternalRoutes);
  await app.ready();
});

afterAll(() => app.close());

const transaction = {
  id: "t1",
  accountId: "acc",
  idempotencyKey: "k",
  type: "usage",
  amount: -250n,
  delta: -250n,
  balanceAfter: 750n,
  applicationId: null,
  metadata: { model: "m" },
  createdAt: new Date("2026-10-09T10:00:00.000Z"),
};

beforeEach(() => {
  mockRequireScope.mockReset().mockResolvedValue({ clientId: "gateway" });
  mockGetOrCreate
    .mockReset()
    .mockResolvedValue({ id: "acc", balance: 1_000n, isUnlimited: false });
  mockRecordUsage
    .mockReset()
    .mockResolvedValue({ transaction, replayed: false });
});

const post = (payload: unknown) =>
  app.inject({
    method: "POST",
    url: "/users/u1/usage",
    payload: payload as object,
  });

describe("GET /users/:userId", () => {
  it("requires wallet:read and returns the balance as a string", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users/u1",
      headers: { authorization: "Bearer tok" },
    });
    expect(mockRequireScope).toHaveBeenCalledWith("Bearer tok", "wallet:read");
    expect(mockGetOrCreate).toHaveBeenCalledWith("user", "u1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      balance: "1000",
      isUnlimited: false,
      currency: "eur",
    });
  });

  it("does not touch the wallet when the caller is not authorized", async () => {
    mockRequireScope.mockRejectedValue(
      ERR.AUTH_011("Missing required scope: wallet:read"),
    );
    const res = await app.inject({ method: "GET", url: "/users/u1" });
    expect(res.statusCode).toBe(403);
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });
});

describe("POST /users/:userId/usage", () => {
  it("requires wallet:debit, records the usage and answers 201", async () => {
    const res = await post({
      amount: "250",
      idempotencyKey: "k",
      applicationSlug: "my-app",
      metadata: { model: "m", tokens: 3, cached: false, tool: null },
    });
    expect(mockRequireScope).toHaveBeenCalledWith(undefined, "wallet:debit");
    expect(mockRecordUsage).toHaveBeenCalledWith({
      accountId: "acc",
      amount: 250n,
      idempotencyKey: "k",
      applicationSlug: "my-app",
      metadata: { model: "m", tokens: 3, cached: false, tool: null },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      replayed: false,
      transaction: {
        id: "t1",
        type: "usage",
        amount: "-250",
        delta: "-250",
        balanceAfter: "750",
        applicationId: null,
        metadata: { model: "m" },
        createdAt: "2026-10-09T10:00:00.000Z",
      },
    });
  });

  it("answers 200 for a replayed key", async () => {
    mockRecordUsage.mockResolvedValue({ transaction, replayed: true });
    const res = await post({ amount: "250", idempotencyKey: "k" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ replayed: boolean }>().replayed).toBe(true);
  });

  it("propagates an insufficient balance as 402 with string details", async () => {
    mockRecordUsage.mockRejectedValue(
      ERR.WAL_002("Insufficient credit balance", {
        balance: "1",
        required: "2",
      }),
    );
    const res = await post({ amount: "2", idempotencyKey: "k" });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({
      error: {
        code: "WAL_002",
        message: "Insufficient credit balance",
        details: { balance: "1", required: "2" },
      },
    });
  });

  it.each([
    ["a zero amount", { amount: "0", idempotencyKey: "k" }],
    ["a negative amount", { amount: "-1", idempotencyKey: "k" }],
    ["a decimal amount", { amount: "1.5", idempotencyKey: "k" }],
    ["a leading-zero amount", { amount: "007", idempotencyKey: "k" }],
    ["a numeric amount", { amount: 5, idempotencyKey: "k" }],
    [
      "a 20-digit amount",
      { amount: "12345678901234567890", idempotencyKey: "k" },
    ],
    ["no idempotency key", { amount: "5" }],
    ["an empty idempotency key", { amount: "5", idempotencyKey: "" }],
    [
      "nested metadata",
      { amount: "5", idempotencyKey: "k", metadata: { a: { b: 1 } } },
    ],
    [
      "more than 32 metadata entries",
      {
        amount: "5",
        idempotencyKey: "k",
        metadata: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`k${i}`, i]),
        ),
      },
    ],
  ])(
    "rejects %s with 400 before touching the wallet",
    async (_label, payload) => {
      const res = await post(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        "APP_001",
      );
      expect(mockRecordUsage).not.toHaveBeenCalled();
    },
  );

  it("does not record anything when the caller is not authorized", async () => {
    mockRequireScope.mockRejectedValue(ERR.AUTH_001());
    const res = await post({ amount: "5", idempotencyKey: "k" });
    expect(res.statusCode).toBe(401);
    expect(mockGetOrCreate).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });
});
