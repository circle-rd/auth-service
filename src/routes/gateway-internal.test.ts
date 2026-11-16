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

const { mockRequireMachineScope, mockListEntitlements } = vi.hoisted(() => ({
  mockRequireMachineScope: vi.fn(),
  mockListEntitlements: vi.fn(),
}));

vi.mock("../services/machine-auth.js", () => ({
  requireMachineScope: mockRequireMachineScope,
}));
vi.mock("../services/gateway-inventory.js", () => ({
  listGatewayEntitlements: mockListEntitlements,
}));

const { gatewayInternalRoutes } = await import("./gateway-internal.js");

const USER = "11111111-1111-4111-8111-111111111111";
const app = createTestApp();

beforeAll(async () => {
  await app.register(gatewayInternalRoutes, {
    prefix: "/api/internal/gateway",
  });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  mockRequireMachineScope.mockReset();
  mockListEntitlements.mockReset();
  mockRequireMachineScope.mockResolvedValue({
    clientId: "litellm-wallet",
    scopes: [],
  });
  mockListEntitlements.mockResolvedValue({
    models: ["gpt-x"],
    agents: [],
    mcpServers: [],
    mcpToolPermissions: {},
    resources: [],
  });
});

describe("gateway internal entitlements", () => {
  it("requires the entitlements scope and returns the resolved lists", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/internal/gateway/users/${USER}/entitlements?applicationSlug=acme`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ models: ["gpt-x"] });
    expect(mockRequireMachineScope).toHaveBeenCalledWith(
      undefined,
      "gateway:entitlements:read",
    );
    expect(mockListEntitlements).toHaveBeenCalledWith(USER);
  });

  it("accepts non-uuid user ids used by BetterAuth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/internal/gateway/users/user_abc/entitlements",
    });
    expect(res.statusCode).toBe(200);
    expect(mockListEntitlements).toHaveBeenCalledWith("user_abc");
  });
});
