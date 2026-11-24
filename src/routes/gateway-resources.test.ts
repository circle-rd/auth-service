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

const {
  mockMachineScope,
  mockAuthorize,
  mockFindByUri,
  mockRecordEvent,
  mockAccessible,
} = vi.hoisted(() => ({
  mockMachineScope: vi.fn(),
  mockAuthorize: vi.fn(),
  mockFindByUri: vi.fn(),
  mockRecordEvent: vi.fn(),
  mockAccessible: vi.fn(),
}));

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../services/machine-auth.js", () => ({
  requireMachineScope: mockMachineScope,
  requireMachineApplication: mockMachineScope,
}));
vi.mock("../services/resources/policy.js", () => ({
  authorize: mockAuthorize,
}));
vi.mock("../services/resources/registry.js", () => ({
  findResourceByUri: mockFindByUri,
}));
vi.mock("../services/resources/usage.js", () => ({
  recordAccessEvent: mockRecordEvent,
  recordUsageEvent: vi.fn(),
}));
vi.mock("../services/resources/access.js", () => ({
  listAccessibleResources: mockAccessible,
}));
vi.mock("../services/resources/validation.js", () => ({
  completeResourceValidation: vi.fn(),
  invalidateResource: vi.fn(),
  VALIDATION_RESULTS: ["validated", "validation_failed"],
}));

const { gatewayResourceRoutes } = await import("./gateway-resources.js");

const app = createTestApp();
beforeAll(async () => {
  await app.register(gatewayResourceRoutes, {
    prefix: "/api/internal/gateway",
  });
  await app.ready();
});
afterAll(() => app.close());

const RESOURCE = {
  id: "22222222-2222-4222-8222-222222222222",
  ownerType: "user",
  ownerId: "owner-1",
  applicationId: "11111111-1111-4111-8111-111111111111",
};
const CALLER = {
  applicationId: "33333333-3333-4333-8333-333333333333",
  clientId: "gateway",
};
const BODY = {
  subjectId: "user-2",
  resourceUri: "gine://project_1",
  audience: "https://auth.test",
};

beforeEach(() => {
  for (const mock of [
    mockMachineScope,
    mockAuthorize,
    mockFindByUri,
    mockRecordEvent,
    mockAccessible,
  ]) {
    mock.mockReset();
  }
  mockMachineScope.mockResolvedValue(CALLER);
  mockFindByUri.mockResolvedValue(RESOURCE);
});

const authorizeCall = () =>
  app.inject({
    method: "POST",
    url: "/api/internal/gateway/authorize",
    payload: BODY,
  });

describe("gateway authorize", () => {
  it("requires the authorize scope before reading the body", async () => {
    mockMachineScope.mockRejectedValue(ERR.AUTH_001());
    const res = await authorizeCall();
    expect(res.statusCode).toBe(401);
    expect(mockMachineScope).toHaveBeenCalledWith(
      undefined,
      "resources:authorize",
    );
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("answers a bare deny and never names the reason", async () => {
    mockAuthorize.mockResolvedValue({ decision: "deny", reason: "no_grant" });
    const res = await authorizeCall();
    expect(res.json()).toEqual({ decision: "deny" });
  });

  it("keeps the owner and application on the denial it records", async () => {
    mockAuthorize.mockResolvedValue({ decision: "deny", reason: "no_grant" });
    await authorizeCall();
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "deny",
        reasonClass: "no_grant",
        resourceId: RESOURCE.id,
        ownerId: "owner-1",
        applicationId: RESOURCE.applicationId,
      }),
    );
  });

  it("records no resource for an unknown URI", async () => {
    mockAuthorize.mockResolvedValue({ decision: "deny", reason: "not_found" });
    await authorizeCall();
    expect(mockFindByUri).not.toHaveBeenCalled();
    const recorded = mockRecordEvent.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(recorded.resourceId).toBeUndefined();
    expect(recorded.applicationId).toBeUndefined();
  });

  it("still answers when the event cannot be recorded", async () => {
    mockAuthorize.mockResolvedValue({ decision: "deny", reason: "no_grant" });
    mockRecordEvent.mockRejectedValue(new Error("db down"));
    const res = await authorizeCall();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ decision: "deny" });
  });

  it("uses the verified client and refuses one sent in the body", async () => {
    mockAuthorize.mockResolvedValue({ decision: "deny", reason: "no_grant" });
    await app.inject({
      method: "POST",
      url: "/api/internal/gateway/authorize",
      payload: { ...BODY, actorClientId: "agent-app" },
    });
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: { id: CALLER.applicationId, slug: CALLER.clientId },
      }),
    );
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CALLER.clientId,
        metadata: { actorClientId: "agent-app" },
      }),
    );

    const forged = await app.inject({
      method: "POST",
      url: "/api/internal/gateway/authorize",
      payload: { ...BODY, clientId: "another-app" },
    });
    expect(forged.statusCode).toBe(400);
  });

  it("hides the owner from an application that does not own the resource", async () => {
    const allow = {
      decision: "allow",
      resourceId: RESOURCE.id,
      resourceUri: "gine://project_1",
      scheme: "gine",
      applicationId: RESOURCE.applicationId,
      applicationSlug: "owner-app",
      ownerType: "user",
      ownerId: "owner-1",
      accessKind: "grant",
      permission: "read",
    };
    mockAuthorize.mockResolvedValue(allow);
    const foreign = (await authorizeCall()).json();
    expect(foreign).toMatchObject({ decision: "allow", permission: "read" });
    expect(foreign.ownerId).toBeUndefined();

    mockAuthorize.mockResolvedValue({
      ...allow,
      applicationId: CALLER.applicationId,
    });
    expect((await authorizeCall()).json().ownerId).toBe("owner-1");
  });

  it("lists only the scope of the verified application", async () => {
    mockAccessible.mockResolvedValue([]);
    await app.inject({
      method: "GET",
      url: "/api/internal/gateway/resources/accessible?subjectId=user-2",
    });
    expect(mockAccessible).toHaveBeenCalledWith({
      subjectId: "user-2",
      scheme: undefined,
      caller: { id: CALLER.applicationId, slug: CALLER.clientId },
    });
  });

  it("rejects unknown body fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/gateway/authorize",
      payload: { ...BODY, isAdmin: true },
    });
    expect(res.statusCode).toBe(400);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });
});
