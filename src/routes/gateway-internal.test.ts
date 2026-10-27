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

const { mockRequireScope, mockResolvePlan } = vi.hoisted(() => ({
  mockRequireScope: vi.fn(),
  mockResolvePlan: vi.fn(),
}));

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/machine-auth.js", () => ({
  requireMachineScope: mockRequireScope,
}));
vi.mock("../services/litellm-plan.js", () => ({
  resolveGatewayPlan: mockResolvePlan,
}));

const { gatewayInternalRoutes } = await import("./gateway-internal.js");

const app = createTestApp();

beforeAll(async () => {
  await app.register(gatewayInternalRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  mockRequireScope
    .mockReset()
    .mockResolvedValue({ clientId: "litellm-wallet" });
  mockResolvePlan.mockReset().mockResolvedValue(null);
});

const get = (url: string, auth = "Bearer token") =>
  app.inject({ method: "GET", url, headers: { authorization: auth } });

describe("gateway internal plan route", () => {
  it("requires the wallet:read machine scope", async () => {
    await get("/users/u1/plan?applicationSlug=app");
    expect(mockRequireScope).toHaveBeenCalledWith(
      "Bearer token",
      "wallet:read",
    );
  });

  it("returns the plan and its team", async () => {
    mockResolvePlan.mockResolvedValue({
      applicationSlug: "app",
      planName: "Premium",
      teamId: "app:premium",
    });
    const res = await get("/users/u1/plan?applicationSlug=app");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plan: "Premium", teamId: "app:premium" });
    expect(mockResolvePlan).toHaveBeenCalledWith("u1", "app");
  });

  it("returns nulls when the user holds no plan", async () => {
    const res = await get("/users/u1/plan?applicationSlug=app");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plan: null, teamId: null });
  });

  it("rejects a missing applicationSlug", async () => {
    const res = await get("/users/u1/plan");
    expect(res.statusCode).toBe(400);
  });

  it("fails when the machine token is refused", async () => {
    mockRequireScope.mockRejectedValue(ERR.AUTH_001());
    const res = await get("/users/u1/plan?applicationSlug=app");
    expect(res.statusCode).toBe(401);
  });
});
