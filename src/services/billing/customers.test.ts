import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";

const { mockCreate, holder, mockDb, state } = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    inserts: [] as Record<string, unknown>[],
  };
  const mockDb = {
    select: () => {
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(state.selects.shift() ?? []),
      };
      return chain;
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        state.inserts.push(values);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
  };
  const mockCreate = vi.fn();
  return {
    mockCreate,
    mockDb,
    state,
    holder: {
      stripe: { customers: { create: mockCreate } } as unknown,
    },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../stripe.js", () => ({
  get stripe() {
    return holder.stripe;
  },
}));

const {
  ensureBillingCustomerBestEffort,
  findBillingCustomer,
  getOrCreateBillingCustomer,
} = await import("./customers.js");

const customer = {
  id: "bc1",
  ownerType: "user",
  ownerId: "u1",
  stripeCustomerId: "cus_123",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const stripeClient = holder.stripe;

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

beforeEach(() => {
  holder.stripe = stripeClient;
  mockCreate.mockReset().mockResolvedValue({ id: "cus_123" });
  state.selects = [];
  state.inserts = [];
});

describe("findBillingCustomer", () => {
  it("returns the customer or undefined without creating one", async () => {
    state.selects.push([customer], []);
    expect(await findBillingCustomer("user", "u1")).toEqual(customer);
    expect(await findBillingCustomer("user", "u2")).toBeUndefined();
    expect(state.inserts).toHaveLength(0);
  });
});

describe("getOrCreateBillingCustomer", () => {
  it("returns an existing customer without calling Stripe", async () => {
    state.selects.push([customer]);
    expect(await getOrCreateBillingCustomer("user", "u1")).toEqual(customer);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it("creates the Stripe customer of an existing owner", async () => {
    state.selects.push([], [{ id: "u1" }], [customer]);
    expect(await getOrCreateBillingCustomer("user", "u1")).toEqual(customer);
    expect(mockCreate).toHaveBeenCalledWith(
      { metadata: { ownerType: "user", ownerId: "u1" } },
      { idempotencyKey: "billing:customer:user:u1" },
    );
    expect(state.inserts).toEqual([
      { ownerType: "user", ownerId: "u1", stripeCustomerId: "cus_123" },
    ]);
  });

  it("rejects an unknown user without creating anything", async () => {
    state.selects.push([], []);
    expect(
      (await rejection(getOrCreateBillingCustomer("user", "x"))).code,
    ).toBe("USR_001");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it("rejects an unknown organization without creating anything", async () => {
    state.selects.push([], []);
    expect((await rejection(getOrCreateBillingCustomer("org", "x"))).code).toBe(
      "ORG_001",
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it("answers 503 and calls nothing when Stripe is not configured", async () => {
    holder.stripe = null;
    const err = await rejection(getOrCreateBillingCustomer("user", "u1"));
    expect(err.code).toBe("BIL_001");
    expect(err.statusCode).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("never fails its caller when the best-effort creation succeeds", async () => {
    state.selects.push([], [{ id: "u1" }], [customer]);
    await expect(
      ensureBillingCustomerBestEffort("user", "u1"),
    ).resolves.toBeUndefined();
  });

  it("swallows a Stripe failure in the best-effort path", async () => {
    state.selects.push([]);
    mockCreate.mockRejectedValueOnce(new Error("stripe down"));
    await expect(
      ensureBillingCustomerBestEffort("user", "u1"),
    ).resolves.toBeUndefined();
    expect(state.inserts).toHaveLength(0);
  });

  it("does nothing in the best-effort path without Stripe", async () => {
    holder.stripe = null;
    await expect(
      ensureBillingCustomerBestEffort("user", "u1"),
    ).resolves.toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("fails loudly when the customer is still missing after creation", async () => {
    state.selects.push([], [{ id: "u1" }], []);
    expect(
      (await rejection(getOrCreateBillingCustomer("user", "u1"))).code,
    ).toBe("SRV_003");
  });
});
