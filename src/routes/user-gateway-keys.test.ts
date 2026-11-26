import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "../tests/helpers/app.js";

const {
  mockRequireUserOrBearerCaller,
  mockList,
  mockCreate,
  mockRevoke,
  mockLoadApp,
} = vi.hoisted(() => ({
  mockRequireUserOrBearerCaller: vi.fn(),
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockRevoke: vi.fn(),
  mockLoadApp: vi.fn(),
}));

vi.mock("../middleware.js", () => ({
  requireUserOrBearerCaller: mockRequireUserOrBearerCaller,
}));
vi.mock("../services/gateway-keys.js", () => ({
  listActiveGatewayKeys: mockList,
  createGatewayKey: mockCreate,
  revokeGatewayKey: mockRevoke,
}));
vi.mock("../services/resources/application-scope.js", () => ({
  loadSharingApplicationBySlug: mockLoadApp,
}));

const { userGatewayKeyRoutes } = await import("./user-gateway-keys.js");
const { RESOURCE_SELF_SCOPE } = await import("../compat/scopes.js");
const { ApiError } = await import("../errors.js");

const APP_ID = "22222222-2222-4222-8222-222222222222";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_APP_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-26T12:00:00Z");

let app: FastifyInstance;

beforeAll(async () => {
  app = createTestApp();
  await app.register(userGatewayKeyRoutes, { prefix: "/api/user" });
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUserOrBearerCaller.mockResolvedValue({
    userId: "user-1",
    clientId: "consumer-app",
  });
  mockLoadApp.mockResolvedValue({
    id: APP_ID,
    slug: "consumer-app",
    allowedResources: [],
  });
  mockList.mockResolvedValue([
    {
      id: KEY_ID,
      label: "IDE",
      organizationId: null,
      maskedKey: "cgk_AbCdEf…wXyZ",
      createdAt: NOW,
      lastUsedAt: null,
    },
  ]);
  mockCreate.mockResolvedValue({
    id: KEY_ID,
    label: "IDE",
    organizationId: null,
    maskedKey: "cgk_AbCdEf…wXyZ",
    key: "cgk_full_secret",
    createdAt: NOW,
    lastUsedAt: null,
  });
});

describe("GET /api/user/gateway-keys", () => {
  it("returns the caller's active keys, masked", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/user/gateway-keys",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      keys: [
        {
          id: KEY_ID,
          label: "IDE",
          organizationId: null,
          maskedKey: "cgk_AbCdEf…wXyZ",
          createdAt: NOW.toISOString(),
          lastUsedAt: null,
        },
      ],
    });
    expect(mockRequireUserOrBearerCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      RESOURCE_SELF_SCOPE,
    );
    expect(mockList).toHaveBeenCalledWith("user-1", APP_ID);
  });

  it("stops when the caller is not authenticated", async () => {
    mockRequireUserOrBearerCaller.mockImplementationOnce(
      async (_req, reply) => {
        await reply.status(401).send({});
        return null;
      },
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/user/gateway-keys",
    });
    expect(res.statusCode).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("scopes the list to the calling application", async () => {
    mockRequireUserOrBearerCaller.mockResolvedValueOnce({
      userId: "user-1",
      clientId: "other-app",
    });
    mockLoadApp.mockResolvedValueOnce({
      id: OTHER_APP_ID,
      slug: "other-app",
      allowedResources: [],
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/user/gateway-keys",
    });
    expect(res.statusCode).toBe(200);
    expect(mockList).toHaveBeenCalledWith("user-1", OTHER_APP_ID);
  });

  it("refuses a web session on the list route", async () => {
    mockRequireUserOrBearerCaller.mockResolvedValueOnce({
      userId: "user-1",
      clientId: null,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/user/gateway-keys",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("KEY_004");
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("POST /api/user/gateway-keys", () => {
  it("returns the full key once with no-store", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/user/gateway-keys",
      payload: { label: "IDE", organizationId: "org_1" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      id: KEY_ID,
      label: "IDE",
      organizationId: null,
      maskedKey: "cgk_AbCdEf…wXyZ",
      key: "cgk_full_secret",
      createdAt: NOW.toISOString(),
    });
    expect(mockCreate).toHaveBeenCalledWith({
      userId: "user-1",
      application: { id: APP_ID, slug: "consumer-app" },
      organizationId: "org_1",
      label: "IDE",
    });
  });

  it("refuses a web session, which has no application to bind", async () => {
    mockRequireUserOrBearerCaller.mockResolvedValueOnce({
      userId: "user-1",
      clientId: null,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/user/gateway-keys",
      payload: { label: "IDE" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("KEY_004");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a caller that is not a sharing application", async () => {
    mockLoadApp.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/user/gateway-keys",
      payload: { label: "IDE" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("KEY_004");
  });

  it("rejects an invalid payload", async () => {
    for (const payload of [{ label: "" }, { label: "x", extra: 1 }, {}]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/user/gateway-keys",
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("KEY_003");
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/user/gateway-keys/:keyId", () => {
  it("revokes an owned key", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/user/gateway-keys/${KEY_ID}`,
    });
    expect(res.statusCode).toBe(204);
    expect(mockRevoke).toHaveBeenCalledWith("user-1", KEY_ID, APP_ID);
  });

  it("returns 404 for an unknown or foreign key", async () => {
    mockRevoke.mockRejectedValueOnce(new ApiError(404, "KEY_002", "missing"));
    const res = await app.inject({
      method: "DELETE",
      url: `/api/user/gateway-keys/${KEY_ID}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("KEY_002");
  });

  it("rejects a malformed key id", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/user/gateway-keys/not-a-uuid",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("KEY_003");
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
