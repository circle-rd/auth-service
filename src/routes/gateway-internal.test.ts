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

const {
  mockRequireMachineScope,
  mockListEntitlements,
  mockRequestSync,
  mockVerifyBearer,
  mockLoadApp,
  mockResolveKey,
  mockTouchKey,
} = vi.hoisted(() => ({
  mockRequireMachineScope: vi.fn(),
  mockListEntitlements: vi.fn(),
  mockRequestSync: vi.fn(),
  mockVerifyBearer: vi.fn(),
  mockLoadApp: vi.fn(),
  mockResolveKey: vi.fn(),
  mockTouchKey: vi.fn(),
}));

vi.mock("../services/machine-auth.js", () => ({
  requireMachineScope: mockRequireMachineScope,
}));
vi.mock("../services/gateway-inventory.js", () => ({
  listGatewayEntitlements: mockListEntitlements,
}));
vi.mock("../services/gateway-keys.js", () => ({
  resolveGatewayKey: mockResolveKey,
  touchGatewayKeyLastUsed: mockTouchKey,
}));
vi.mock("../services/gateway-inventory-sync.js", () => ({
  requestGatewayInventorySync: mockRequestSync,
}));
vi.mock("../services/oauth-tokens.js", () => ({
  verifyBearerAccessToken: mockVerifyBearer,
}));
vi.mock("../services/resources/application-scope.js", () => ({
  loadSharingApplicationBySlug: mockLoadApp,
}));

const { gatewayInternalRoutes } = await import("./gateway-internal.js");
const { verifyDecision } =
  await import("../services/resources/decision-token.js");

const TOKEN = "t".repeat(40);
const APP_ID = "22222222-2222-4222-8222-222222222222";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const PERSONAL_KEY = `cgk_${"A".repeat(43)}`;
const app = createTestApp();

beforeAll(async () => {
  await app.register(gatewayInternalRoutes, {
    prefix: "/api/internal/gateway",
  });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  for (const mock of [
    mockRequireMachineScope,
    mockListEntitlements,
    mockRequestSync,
    mockVerifyBearer,
    mockLoadApp,
    mockResolveKey,
    mockTouchKey,
  ]) {
    mock.mockReset();
  }
  mockRequireMachineScope.mockResolvedValue({ clientId: "litellm-wallet" });
  mockVerifyBearer.mockResolvedValue({
    clientId: "consumer-app",
    userId: "user_abc",
    audiences: ["https://llm.example"],
    scopes: [],
    expiresAt: null,
  });
  mockLoadApp.mockResolvedValue({
    id: APP_ID,
    slug: "consumer-app",
    allowedResources: [],
  });
  mockListEntitlements.mockResolvedValue({
    models: ["gpt-x"],
    agents: [],
    mcpServers: [],
    mcpToolPermissions: {},
    resources: [],
  });
  mockResolveKey.mockResolvedValue({
    keyId: KEY_ID,
    userId: "user_abc",
    caller: { id: APP_ID, slug: "consumer-app" },
    pool: null,
  });
});

const introspect = (payload: unknown = { token: TOKEN }) =>
  app.inject({
    method: "POST",
    url: "/api/internal/gateway/entitlements",
    payload: payload as Record<string, unknown>,
  });

describe("gateway entitlements by token introspection", () => {
  it("derives the user and application from the token, not from the caller", async () => {
    const res = await introspect();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      subjectId: "user_abc",
      clientId: "consumer-app",
      models: ["gpt-x"],
    });
    expect(mockRequireMachineScope).toHaveBeenCalledWith(
      undefined,
      "gateway:entitlements:read",
    );
    expect(mockVerifyBearer).toHaveBeenCalledWith(TOKEN);
    expect(mockListEntitlements).toHaveBeenCalledWith("user_abc", {
      id: APP_ID,
      slug: "consumer-app",
    });
  });

  it("signs a decision for that user and application, handed to the caller", async () => {
    const body = (await introspect()).json();
    expect(verifyDecision(body.decisionId)).toMatchObject({
      sub: "user_abc",
      app: "consumer-app",
      by: "litellm-wallet",
    });
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("never outlives the user's token", async () => {
    const soon = Math.floor(Date.now() / 1000) + 5;
    mockVerifyBearer.mockResolvedValue({
      clientId: "consumer-app",
      userId: "user_abc",
      audiences: ["https://llm.example"],
      scopes: [],
      expiresAt: soon,
    });
    const body = (await introspect()).json();
    expect(verifyDecision(body.decisionId).exp).toBe(soon);
  });

  it("refuses an invalid token, a machine token and an unscoped client", async () => {
    mockVerifyBearer.mockResolvedValueOnce(null);
    expect((await introspect()).statusCode).toBe(401);

    mockVerifyBearer.mockResolvedValueOnce({
      clientId: "consumer-app",
      userId: null,
      audiences: [],
      scopes: [],
      expiresAt: null,
    });
    expect((await introspect()).statusCode).toBe(403);

    mockLoadApp.mockResolvedValueOnce(null);
    expect((await introspect()).statusCode).toBe(403);
    expect(mockListEntitlements).not.toHaveBeenCalled();
  });

  it("refuses a body that names a user, a client or anything else", async () => {
    for (const extra of [{ userId: "x" }, { clientId: "x" }]) {
      const res = await introspect({ token: TOKEN, ...extra });
      expect(res.statusCode).toBe(400);
    }
    expect((await introspect({})).statusCode).toBe(400);
  });

  it("no longer answers the old route that took a user id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/internal/gateway/users/user_abc/entitlements",
    });
    expect(res.statusCode).toBe(404);
  });
});

const resolvePersonalKey = (payload: unknown = { key: PERSONAL_KEY }) =>
  app.inject({
    method: "POST",
    url: "/api/internal/gateway/personal-keys/entitlements",
    payload: payload as Record<string, unknown>,
  });

describe("personal gateway key resolution", () => {
  it("returns the entitlements and a decision that names the key", async () => {
    const res = await resolvePersonalKey();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      keyId: KEY_ID,
      subjectId: "user_abc",
      clientId: "consumer-app",
      models: ["gpt-x"],
    });
    expect(mockResolveKey).toHaveBeenCalledWith(PERSONAL_KEY);
    expect(mockListEntitlements).toHaveBeenCalledWith(
      "user_abc",
      { id: APP_ID, slug: "consumer-app" },
      {},
    );
    expect(mockTouchKey).toHaveBeenCalledWith(KEY_ID);
    expect(verifyDecision(res.json().decisionId)).toMatchObject({
      sub: "user_abc",
      app: "consumer-app",
      by: "litellm-wallet",
      key: KEY_ID,
    });
  });

  it("narrows the entitlement query to the key's pool", async () => {
    mockResolveKey.mockResolvedValueOnce({
      keyId: KEY_ID,
      userId: "user_abc",
      caller: { id: APP_ID, slug: "consumer-app" },
      pool: "org_1",
    });
    const res = await resolvePersonalKey();
    expect(res.statusCode).toBe(200);
    expect(mockListEntitlements).toHaveBeenCalledWith(
      "user_abc",
      { id: APP_ID, slug: "consumer-app" },
      { pool: "org_1" },
    );
  });

  it("maps service refusals to the documented statuses", async () => {
    const { ApiError } = await import("../errors.js");
    mockResolveKey.mockRejectedValueOnce(new ApiError(401, "KEY_001", "bad"));
    expect((await resolvePersonalKey()).statusCode).toBe(401);

    mockResolveKey.mockRejectedValueOnce(new ApiError(403, "KEY_004", "no"));
    expect((await resolvePersonalKey()).statusCode).toBe(403);
    expect(mockTouchKey).not.toHaveBeenCalled();
  });

  it("refuses a body without a key and signs a decision for the machine", async () => {
    mockRequireMachineScope.mockResolvedValueOnce({ clientId: "litellm" });
    expect((await resolvePersonalKey({ key: 1 })).statusCode).toBe(400);
    expect((await resolvePersonalKey({})).statusCode).toBe(400);
    expect(mockResolveKey).not.toHaveBeenCalled();
  });
});

describe("gateway inventory change notification", () => {
  it("requires the inventory sync scope and schedules a sync", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/gateway/inventory-changed",
    });
    expect(res.statusCode).toBe(202);
    expect(mockRequireMachineScope).toHaveBeenCalledWith(
      undefined,
      "gateway:inventory:sync",
    );
    expect(mockRequestSync).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a sync when the caller is refused", async () => {
    mockRequireMachineScope.mockRejectedValueOnce(new Error("forbidden"));
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/gateway/inventory-changed",
    });
    expect(res.statusCode).not.toBe(202);
    expect(mockRequestSync).not.toHaveBeenCalled();
  });
});
