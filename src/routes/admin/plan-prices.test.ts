import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { planPricesRoutes } from "./plan-prices.js";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const { mockDb, mockGetSession } = vi.hoisted(() => {
  function makeChain(result: unknown[] = []): Record<string, unknown> {
    const p = Promise.resolve(result);
    const c: Record<string, unknown> = {
      from: () => c,
      where: () => c,
      innerJoin: () => c,
      leftJoin: () => c,
      orderBy: () => c,
      limit: () => c,
      values: () => c,
      set: () => c,
      returning: () => Promise.resolve(result),
      then: p.then.bind(p),
      catch: p.catch.bind(p),
      finally: p.finally.bind(p),
    };
    return c;
  }
  const mockDb = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  };
  const mockGetSession = vi.fn();
  return { mockDb, mockGetSession };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));
vi.mock("../../services/stripe.js", () => ({ stripe: null }));

const adminSession = { user: { id: "admin-1", role: "admin" } };
const APP_ID = "app-uuid-1234";
const PLAN_ID = "plan-uuid-5678";

describe("Admin — planPricesRoutes (validation)", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(planPricesRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  function post(payload: Record<string, unknown>) {
    mockGetSession.mockResolvedValueOnce(adminSession);
    return app.inject({
      method: "POST",
      url: `/applications/${APP_ID}/plans/${PLAN_ID}/prices`,
      payload,
    });
  }

  const fixed = {
    name: "monthly",
    amount: 1000,
    currency: "usd",
    interval: "month",
  };

  it("400 when the amount is negative", async () => {
    expect((await post({ ...fixed, amount: -1 })).statusCode).toBe(400);
  });

  it("400 when a metered price omits the feature key", async () => {
    const res = await post({
      ...fixed,
      billingType: "metered",
      unit: "call",
      usageLimit: 100,
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 when a metered price omits the unit", async () => {
    const res = await post({
      ...fixed,
      billingType: "metered",
      featureKey: "api.calls",
      usageLimit: 100,
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 when a metered price omits the cap", async () => {
    const res = await post({
      ...fixed,
      billingType: "metered",
      featureKey: "api.calls",
      unit: "call",
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 when a metered price is one-off", async () => {
    const res = await post({
      ...fixed,
      interval: "one_time",
      billingType: "metered",
      featureKey: "api.calls",
      unit: "call",
      usageLimit: 100,
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 when a fixed price carries metered fields", async () => {
    expect((await post({ ...fixed, featureKey: "api.calls" })).statusCode).toBe(
      400,
    );
  });

  it("401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "POST",
      url: `/applications/${APP_ID}/plans/${PLAN_ID}/prices`,
      payload: fixed,
    });
    expect(res.statusCode).toBe(401);
  });
});
