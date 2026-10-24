import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { servicesRoutes } from "./services.js";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }));
vi.mock("../../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));
vi.mock("../../db/index.js", () => ({ db: {} }));
vi.mock("../../config.js", () => ({
  config: {
    stripe: { secretKey: "sk_test" },
    compat: {
      profile: "okta",
      tokenAuthMethod: "basic",
      signingAlg: "RS256",
      defaultAudience: true,
      audienceParam: false,
      claimMappings: [{ claim: "cid", source: "clientId" }],
      aliases: ["okta"],
    },
    providers: {
      google: { enabled: true, clientId: "g-id", clientSecret: "g-secret" },
      github: { enabled: false },
      linkedin: { enabled: false },
      microsoft: { enabled: false },
      apple: { enabled: false },
    },
  },
}));

describe("Admin — servicesRoutes", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(servicesRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  it("requires an admin session", async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(
      401,
    );
  });

  it("reports integrations and the compatibility settings without secrets", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "a", role: "admin" } });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      stripe: boolean;
      compat: Record<string, unknown>;
      providers: { google: Record<string, unknown> };
    };
    expect(body.stripe).toBe(true);
    expect(body.compat).toMatchObject({
      profile: "okta",
      signingAlg: "RS256",
      claimMappings: [{ claim: "cid", source: "clientId" }],
    });
    expect(body.providers.google).toEqual({ enabled: true, clientId: "g-id" });
    expect(res.body).not.toContain("g-secret");
  });
});
