import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestApp } from "../../tests/helpers/app.js";

const { mockDb, mockRole, mockRevoke, mockPublish, state } = vi.hoisted(() => {
  const state = {
    app: [] as unknown[],
    updates: [] as Record<string, unknown>[],
  };
  const selectChain: Record<string, unknown> = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(state.app),
  };
  const mockDb = {
    select: () => selectChain,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.updates.push(values);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return {
    mockDb,
    mockRole: vi.fn(),
    mockRevoke: vi.fn(),
    mockPublish: vi.fn(),
    state,
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("../../middleware.js", () => ({
  requireAdmin: vi.fn(async () => undefined),
  getCallerRole: mockRole,
}));
vi.mock("../../services/oauth-tokens.js", () => ({
  revokeClientTokens: mockRevoke,
}));
vi.mock("../../services/event-bus.js", () => ({ publishEvent: mockPublish }));

const { applicationMachineScopesRoutes } =
  await import("./application-machine-scopes.js");

const app = createTestApp();

beforeAll(async () => {
  await app.register(applicationMachineScopesRoutes);
  await app.ready();
});

afterAll(() => app.close());

const ID = "6f1c2c1e-3b6a-4a39-9e0a-3f9d7f2f6b10";

beforeEach(() => {
  state.app = [
    {
      slug: "gateway",
      isPublic: false,
      scopes: ["wallet:read", "wallet:debit"],
    },
  ];
  state.updates = [];
  mockRole.mockReset().mockResolvedValue("superadmin");
  mockRevoke.mockReset();
  mockPublish.mockReset();
});

const put = (scopes: unknown, id = ID) =>
  app.inject({
    method: "PUT",
    url: `/${id}/machine-scopes`,
    payload: { scopes } as object,
  });

describe("GET /:id/machine-scopes", () => {
  it("returns the current scopes, empty when none", async () => {
    expect(
      (
        await app.inject({ method: "GET", url: `/${ID}/machine-scopes` })
      ).json(),
    ).toEqual({
      scopes: ["wallet:read", "wallet:debit"],
    });
    state.app = [{ slug: "gateway", isPublic: false, scopes: null }];
    expect(
      (
        await app.inject({ method: "GET", url: `/${ID}/machine-scopes` })
      ).json(),
    ).toEqual({
      scopes: [],
    });
  });

  it("answers 404 for an unknown application and 400 for a malformed id", async () => {
    state.app = [];
    expect(
      (await app.inject({ method: "GET", url: `/${ID}/machine-scopes` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/not-a-uuid/machine-scopes" }))
        .statusCode,
    ).toBe(400);
  });
});

describe("PUT /:id/machine-scopes", () => {
  it("is refused to anyone but a superadmin", async () => {
    mockRole.mockResolvedValue("admin");
    const res = await put(["wallet:read"]);
    expect(res.statusCode).toBe(403);
    expect(state.updates).toHaveLength(0);
  });

  it("replaces the scopes, de-duplicated, and announces the change", async () => {
    const res = await put([
      "wallet:read",
      "wallet:debit",
      "wallet:read",
      "m2m",
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      scopes: ["wallet:read", "wallet:debit", "m2m"],
    });
    expect(state.updates).toEqual([
      { clientCredentialsScopes: ["wallet:read", "wallet:debit", "m2m"] },
    ]);
    expect(mockPublish).toHaveBeenCalledWith("application.changed");
  });

  it("does not revoke tokens when scopes are only added", async () => {
    await put(["wallet:read", "wallet:debit", "m2m"]);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("revokes the client's tokens when a scope is removed", async () => {
    await put(["wallet:read"]);
    expect(mockRevoke).toHaveBeenCalledWith("gateway");
  });

  it("accepts an empty list to switch machine access off", async () => {
    const res = await put([]);
    expect(res.statusCode).toBe(200);
    expect(mockRevoke).toHaveBeenCalledWith("gateway");
  });

  it("rejects public applications, unknown scopes and unknown applications", async () => {
    state.app = [{ slug: "spa", isPublic: true, scopes: [] }];
    expect((await put(["wallet:read"])).statusCode).toBe(400);

    state.app = [{ slug: "gateway", isPublic: false, scopes: [] }];
    expect((await put(["wallet:everything"])).statusCode).toBe(400);
    expect((await put("wallet:read")).statusCode).toBe(400);

    state.app = [];
    expect((await put(["wallet:read"])).statusCode).toBe(404);
    expect(state.updates).toHaveLength(0);
  });
});
