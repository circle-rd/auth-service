import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";

const { mockCreate, mockUpdate, holder, mockDb, state } = vi.hoisted(() => {
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
  const mockUpdate = vi.fn();
  return {
    mockCreate,
    mockUpdate,
    mockDb,
    state,
    holder: {
      stripe: {
        customers: { create: mockCreate, update: mockUpdate },
      } as unknown,
    },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../stripe.js", () => ({
  get stripe() {
    return holder.stripe;
  },
}));

const { customerMatchesProfile } = await import("./customer-profile.js");
const {
  billingCustomerIdBestEffort,
  ensureBillingCustomerBestEffort,
  findBillingCustomer,
  getOrCreateBillingCustomer,
  syncBillingCustomer,
  syncBillingCustomerBestEffort,
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
  mockUpdate.mockReset().mockResolvedValue({ id: "cus_123" });
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

  it("creates the Stripe customer with the full local profile", async () => {
    state.selects.push(
      [],
      [
        {
          id: "u1",
          name: "Ada Lovelace",
          email: "ada@example.com",
          phone: "+33123456789",
          firstName: "Ada",
          lastName: "Lovelace",
          username: "ada",
          company: "Analytical Engines",
          position: "Engineer",
          address: "12 rue de la Paix",
          postalCode: "75002",
          city: "Paris",
          region: "Ile-de-France",
          country: "fr",
        },
      ],
      [customer],
    );
    await getOrCreateBillingCustomer("user", "u1");
    expect(mockCreate).toHaveBeenCalledWith(
      {
        metadata: {
          ownerType: "user",
          ownerId: "u1",
          username: "ada",
          company: "Analytical Engines",
          position: "Engineer",
          country: "FR",
        },
        name: "Ada Lovelace",
        email: "ada@example.com",
        phone: "+33123456789",
        description: "Engineer at Analytical Engines",
        address: {
          line1: "12 rue de la Paix",
          city: "Paris",
          state: "Ile-de-France",
          postal_code: "75002",
          country: "FR",
        },
      },
      { idempotencyKey: "billing:customer:user:u1" },
    );
  });

  it("pushes a profile change onto the existing Stripe customer", async () => {
    state.selects.push(
      [customer],
      [
        {
          id: "u1",
          name: "Ada Lovelace",
          email: "ada@example.com",
          phone: null,
          firstName: "Ada",
          lastName: "Lovelace",
          username: "ada",
          company: "Analytical Engines",
          position: "Engineer",
          address: null,
          postalCode: null,
          city: null,
          region: null,
          country: null,
        },
      ],
    );
    await syncBillingCustomer("user", "u1");
    expect(mockUpdate).toHaveBeenCalledWith("cus_123", {
      metadata: {
        ownerType: "user",
        ownerId: "u1",
        username: "ada",
        company: "Analytical Engines",
        position: "Engineer",
        country: "",
      },
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "",
      description: "Engineer at Analytical Engines",
      address: "",
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates an organization customer with its domain metadata", async () => {
    state.selects.push(
      [],
      [{ name: "Acme", slug: "acme", domain: "acme.com" }],
      [{ ...customer, ownerType: "org", ownerId: "o1" }],
    );
    await getOrCreateBillingCustomer("org", "o1");
    expect(mockCreate).toHaveBeenCalledWith(
      {
        metadata: {
          ownerType: "org",
          ownerId: "o1",
          organizationSlug: "acme",
          domain: "acme.com",
        },
        name: "Acme",
        description: "acme.com",
      },
      { idempotencyKey: "billing:customer:org:o1" },
    );
  });

  it("updates an organization customer with its org metadata", async () => {
    state.selects.push(
      [{ ...customer, ownerType: "org", ownerId: "o1" }],
      [{ name: "Acme", slug: "acme", domain: "acme.com" }],
    );
    await syncBillingCustomer("org", "o1");
    expect(mockUpdate).toHaveBeenCalledWith("cus_123", {
      metadata: {
        ownerType: "org",
        ownerId: "o1",
        organizationSlug: "acme",
        domain: "acme.com",
      },
      name: "Acme",
      email: "",
      phone: "",
      description: "acme.com",
      address: "",
    });
  });

  it("detects whether a Stripe customer already matches a profile", () => {
    const profile = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: null,
      description: "Engineer at Acme",
      address: {
        line1: "12 rue de la Paix",
        city: "Paris",
        state: "Ile-de-France",
        postal_code: "75002",
        country: "FR",
      },
      metadata: {
        ownerType: "user",
        ownerId: "u1",
        username: "ada",
        company: "Acme",
        position: "Engineer",
        country: "FR",
      },
    };
    const matching = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: null,
      description: "Engineer at Acme",
      address: profile.address,
      metadata: profile.metadata,
    };
    expect(customerMatchesProfile(matching as never, profile)).toBe(true);
    expect(
      customerMatchesProfile(
        { ...matching, phone: "+33123456789" } as never,
        profile,
      ),
    ).toBe(false);
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

  it("returns the customer id, or null when Stripe is unavailable", async () => {
    state.selects.push([customer]);
    expect(await billingCustomerIdBestEffort("user", "u1")).toBe("cus_123");
    expect(mockUpdate).not.toHaveBeenCalled();
    holder.stripe = null;
    expect(await billingCustomerIdBestEffort("user", "u1")).toBeNull();
  });

  it("swallows a failure in the profile sync best-effort path", async () => {
    state.selects.push([customer], []);
    await expect(
      syncBillingCustomerBestEffort("user", "u1"),
    ).resolves.toBeUndefined();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("fails loudly when the customer is still missing after creation", async () => {
    state.selects.push([], [{ id: "u1" }], []);
    expect(
      (await rejection(getOrCreateBillingCustomer("user", "u1"))).code,
    ).toBe("SRV_003");
  });
});
