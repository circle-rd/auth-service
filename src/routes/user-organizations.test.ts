import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const {
  mockRequireUserOrBearer,
  mockCreateTeam,
  mockJoinTeam,
  mockLeaveTeam,
  mockIssue,
  mockRevoke,
  mockList,
} = vi.hoisted(() => ({
  mockRequireUserOrBearer: vi.fn(),
  mockCreateTeam: vi.fn(),
  mockJoinTeam: vi.fn(),
  mockLeaveTeam: vi.fn(),
  mockIssue: vi.fn(),
  mockRevoke: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock("../middleware.js", () => ({
  requireUserOrBearer: mockRequireUserOrBearer,
}));
vi.mock("../services/teams.js", () => ({
  createTeam: mockCreateTeam,
  joinTeam: mockJoinTeam,
  leaveTeam: mockLeaveTeam,
  issueInvitationToken: mockIssue,
  revokeInvitationToken: mockRevoke,
}));
vi.mock("../services/user-organizations.js", () => ({
  listUserOrganizations: mockList,
}));

const { userOrganizationRoutes } = await import("./user-organizations.js");
const { ORGANIZATION_SELF_SCOPE, RESOURCE_SELF_SCOPE } =
  await import("../compat/scopes.js");

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(userOrganizationRoutes, {
    prefix: "/api/user/organizations",
  });
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUserOrBearer.mockResolvedValue("user-1");
});

describe("GET /api/user/organizations", () => {
  it("accepts either the teams or the resource scope and forwards the team filter", async () => {
    mockList.mockResolvedValueOnce([{ id: "team-1" }]);

    const res = await app.inject({
      method: "GET",
      url: "/api/user/organizations?team=true",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ organizations: [{ id: "team-1" }] });
    expect(mockRequireUserOrBearer).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [ORGANIZATION_SELF_SCOPE, RESOURCE_SELF_SCOPE],
    );
    expect(mockList).toHaveBeenCalledWith("user-1", true);
  });

  it("lists every membership when no filter is given", async () => {
    mockList.mockResolvedValueOnce([]);
    await app.inject({ method: "GET", url: "/api/user/organizations" });
    expect(mockList).toHaveBeenCalledWith("user-1", undefined);
  });

  it("refuses an invalid team filter before listing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/user/organizations?team=maybe",
    });
    expect(res.statusCode).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("stops when the caller is not authenticated", async () => {
    mockRequireUserOrBearer.mockImplementationOnce(async (_req, reply) => {
      await reply.status(401).send({});
      return "";
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/user/organizations",
    });
    expect(res.statusCode).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("POST /api/user/organizations", () => {
  it("creates a team from a name and optional fields", async () => {
    mockCreateTeam.mockResolvedValueOnce({ id: "team-1", team: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/user/organizations",
      payload: { name: "Acme", logo: "https://cdn.example.com/a.png" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ organization: { id: "team-1", team: true } });
    expect(mockRequireUserOrBearer).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ORGANIZATION_SELF_SCOPE,
    );
    expect(mockCreateTeam).toHaveBeenCalledWith("user-1", {
      name: "Acme",
      logo: "https://cdn.example.com/a.png",
    });
  });

  it.each([
    { domain: "example.com" },
    { verifyDomain: false },
    { autoEnrollEnabled: true },
    { team: false },
    { metadata: {} },
    { slug: "chosen-by-client" },
  ])("refuses the field %o before creating anything", async (extra) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/user/organizations",
      payload: { name: "Acme", ...extra },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreateTeam).not.toHaveBeenCalled();
  });

  it("refuses a logo that is not https", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/user/organizations",
      payload: { name: "Acme", logo: "http://example.com/a.png" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreateTeam).not.toHaveBeenCalled();
  });
});

describe("POST /api/user/organizations/join", () => {
  it("redeems the token as the caller", async () => {
    mockJoinTeam.mockResolvedValueOnce({ id: "team-1", role: "member" });

    const res = await app.inject({
      method: "POST",
      url: "/api/user/organizations/join",
      payload: { token: "abc" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockJoinTeam).toHaveBeenCalledWith("user-1", "abc");
  });

  it("refuses a body without a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/user/organizations/join",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(mockJoinTeam).not.toHaveBeenCalled();
  });
});

describe("team membership and invitation token", () => {
  it("leaves a team with 204", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/user/organizations/team-1/leave",
    });
    expect(res.statusCode).toBe(204);
    expect(mockLeaveTeam).toHaveBeenCalledWith("user-1", "team-1");
  });

  it("issues the invitation token", async () => {
    const expiresAt = new Date("2026-12-01T00:00:00.000Z");
    mockIssue.mockResolvedValueOnce({ token: "tok", expiresAt });

    const res = await app.inject({
      method: "POST",
      url: "/api/user/organizations/team-1/invitation-token",
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      token: "tok",
      expiresAt: expiresAt.toISOString(),
    });
    expect(mockIssue).toHaveBeenCalledWith("user-1", "team-1");
  });

  it("revokes the invitation token with 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/user/organizations/team-1/invitation-token",
    });
    expect(res.statusCode).toBe(204);
    expect(mockRevoke).toHaveBeenCalledWith("user-1", "team-1");
  });
});
