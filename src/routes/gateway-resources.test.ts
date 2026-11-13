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

const { mockRequireScope, mockAuthorize, mockAccessible, mockRecordUsage } =
  vi.hoisted(() => ({
    mockRequireScope: vi.fn(),
    mockAuthorize: vi.fn(),
    mockAccessible: vi.fn(),
    mockRecordUsage: vi.fn(),
  }));

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/machine-auth.js", () => ({
  requireMachineScope: mockRequireScope,
}));
vi.mock("../services/resource-sharing/policy.js", () => ({
  authorize: mockAuthorize,
}));
vi.mock("../services/resource-sharing/accessible.js", () => ({
  listAccessibleResources: mockAccessible,
}));
vi.mock("../services/resource-sharing/usage.js", () => ({
  recordUsageEvent: mockRecordUsage,
  USAGE_SOURCES: ["provider", "unsupported"],
}));

const { gatewayResourceRoutes } = await import("./gateway-resources.js");

const app = createTestApp();

beforeAll(async () => {
  await app.register(gatewayResourceRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  mockRequireScope.mockReset().mockResolvedValue({ clientId: "gateway" });
  mockAuthorize.mockReset();
  mockAccessible.mockReset().mockResolvedValue([]);
  mockRecordUsage.mockReset().mockResolvedValue({
    record: {
      id: "usage-1",
      ownerApplicationId: "owner-app",
      resourceId: "11111111-1111-4111-8111-111111111111",
      resourceType: "model",
      usageSource: "provider",
      requestId: "a".repeat(64),
      occurredAt: new Date("2026-11-13T00:00:00.000Z"),
    },
    replayed: false,
  });
});

const body = {
  subjectId: "subject-a",
  clientId: "app-b",
  resourceType: "model",
  key: "app-a/model-a",
  audience: "https://gateway.example.test",
  requestId: "req-1",
};

const post = (payload: Record<string, unknown> = body) =>
  app.inject({
    method: "POST",
    url: "/authorize",
    headers: {
      authorization: "Bearer token",
      "content-type": "application/json",
    },
    payload,
  });

const get = (query: string) =>
  app.inject({
    method: "GET",
    url: `/resources/accessible?${query}`,
    headers: { authorization: "Bearer token" },
  });

describe("POST /authorize", () => {
  it("requires the resources:authorize machine scope", async () => {
    await post();
    expect(mockRequireScope).toHaveBeenCalledWith(
      "Bearer token",
      "resources:authorize",
    );
  });

  it("returns the allow decision without leaking the key", async () => {
    mockAuthorize.mockResolvedValue({
      decision: "allow",
      resourceId: "resource-1",
      resourceKey: "app-a/model-a",
      ownerApplicationId: "owner-app",
      ownerApplicationSlug: "app-a",
      planName: "Team",
      teamId: "app-a:team",
      subjectId: "subject-a",
      clientId: "app-b",
      resourceType: "model",
      grantKind: "explicit",
    });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      decision: "allow",
      ownerApplicationSlug: "app-a",
      planName: "Team",
      teamId: "app-a:team",
      resourceId: "resource-1",
    });
  });

  it("returns a bare deny without metadata", async () => {
    mockAuthorize.mockResolvedValue({ decision: "deny", reason: "no_grant" });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ decision: "deny" });
  });

  it("passes the validated input to the authorizer", async () => {
    mockAuthorize.mockResolvedValue({ decision: "deny", reason: "no_grant" });
    await post();
    expect(mockAuthorize).toHaveBeenCalledWith({
      subjectId: "subject-a",
      clientId: "app-b",
      resourceType: "model",
      key: "app-a/model-a",
      audience: "https://gateway.example.test",
    });
  });

  it.each([
    ["resourceType", "ssh_host"],
    ["subjectId", ""],
    ["audience", ""],
    ["requestId", ""],
    ["key", ""],
  ])("rejects an invalid %s with 400", async (field, value) => {
    const res = await post({ ...body, [field]: value });
    expect(res.statusCode).toBe(400);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("fails when the machine token is refused", async () => {
    mockRequireScope.mockRejectedValue(ERR.AUTH_001());
    const res = await post();
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /resources/accessible", () => {
  const query =
    "subjectId=subject-a&clientId=app-b&resourceType=model&audience=https%3A%2F%2Fgateway.example.test";

  it("returns the subject-scoped list", async () => {
    mockAccessible.mockResolvedValue([
      {
        resourceId: "resource-1",
        resourceKey: "app-a/model-a",
        resourceUri: "llm://app-a/model-a",
        resourceType: "model",
        displayName: "Model A",
        ownerApplicationSlug: "app-a",
        planName: "Team",
        teamId: "app-a:team",
      },
    ]);
    const res = await get(query);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      resources: [
        {
          resourceId: "resource-1",
          resourceKey: "app-a/model-a",
          resourceUri: "llm://app-a/model-a",
          resourceType: "model",
          displayName: "Model A",
          ownerApplicationSlug: "app-a",
          planName: "Team",
          teamId: "app-a:team",
        },
      ],
    });
  });

  it("requires the resources:authorize machine scope", async () => {
    await get(query);
    expect(mockRequireScope).toHaveBeenCalledWith(
      "Bearer token",
      "resources:authorize",
    );
  });

  it("rejects a missing subjectId with 400", async () => {
    const res = await get(
      "clientId=app-b&resourceType=model&audience=https%3A%2F%2Fgateway.example.test",
    );
    expect(res.statusCode).toBe(400);
    expect(mockAccessible).not.toHaveBeenCalled();
  });

  it.each(["ssh_host", ""])(
    "rejects an invalid resourceType %j",
    async (type) => {
      const res = await get(
        `subjectId=subject-a&clientId=app-b&resourceType=${type}&audience=https%3A%2F%2Fgateway.example.test`,
      );
      expect(res.statusCode).toBe(400);
    },
  );
});

describe("POST /usage", () => {
  const resourceId = "11111111-1111-4111-8111-111111111111";
  const usage = (overrides: Record<string, unknown> = {}) => ({
    subjectId: "subject-a",
    clientId: "app-b",
    resourceId,
    resourceType: "model",
    resourceKey: "app-a/model-a",
    planName: "Team",
    requestId: "a".repeat(64),
    occurredAt: new Date().toISOString(),
    usageSource: "provider",
    costUsd: "0.01",
    promptTokens: 6,
    completionTokens: 4,
    totalTokens: 10,
    ...overrides,
  });

  const postUsage = (payload: Record<string, unknown> = usage()) =>
    app.inject({
      method: "POST",
      url: "/usage",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      payload,
    });

  it("requires the resources:usage:write machine scope", async () => {
    await postUsage();
    expect(mockRequireScope).toHaveBeenCalledWith(
      "Bearer token",
      "resources:usage:write",
    );
  });

  it("passes the validated event to the ledger", async () => {
    const res = await postUsage();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      usage: { id: "usage-1", requestId: "a".repeat(64) },
      replayed: false,
    });
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: "subject-a",
        clientId: "app-b",
        resourceType: "model",
        resourceKey: "app-a/model-a",
        planName: "Team",
        requestId: "a".repeat(64),
        costUsd: "0.01",
        totalTokens: 10,
      }),
    );
  });

  it("returns 200 for an idempotent replay", async () => {
    mockRecordUsage.mockResolvedValueOnce({
      record: {
        id: "usage-1",
        ownerApplicationId: "owner-app",
        resourceId,
        resourceType: "model",
        usageSource: "provider",
        requestId: "a".repeat(64),
        occurredAt: new Date("2026-11-13T00:00:00.000Z"),
      },
      replayed: true,
    });
    const res = await postUsage();
    expect(res.statusCode).toBe(200);
    expect((res.json() as { replayed: boolean }).replayed).toBe(true);
  });

  it("accepts an explicit unsupported non-model event", async () => {
    const res = await postUsage(
      usage({
        resourceType: "mcp_agent",
        resourceKey: "app-a/agent-a",
        usageSource: "unsupported",
        costUsd: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      }),
    );
    expect(res.statusCode).toBe(201);
  });

  it.each([
    ["requestId", "short"],
    ["costUsd", null],
    ["usageSource", "guessed"],
    ["totalTokens", -1],
    ["resourceId", "not-a-uuid"],
  ])("rejects an invalid %s with 400", async (field, value) => {
    const res = await postUsage(usage({ [field]: value }));
    expect(res.statusCode).toBe(400);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("rejects unsupported usage carrying cost or tokens", async () => {
    const res = await postUsage(
      usage({ usageSource: "unsupported", costUsd: "0.01" }),
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects an occurrence outside the accounting window", async () => {
    const res = await postUsage(
      usage({
        occurredAt: new Date(Date.now() - 60 * 24 * 3600_000).toISOString(),
      }),
    );
    expect(res.statusCode).toBe(400);
  });
});
