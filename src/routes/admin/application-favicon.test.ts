import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const { mockGetSession, detectFavicon } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  detectFavicon: vi.fn(),
}));
vi.mock("../../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));
vi.mock("../../services/favicon.js", () => ({ detectFavicon }));

import { applicationFaviconRoutes } from "./application-favicon.js";

describe("Admin — applicationFaviconRoutes", () => {
  const app = Fastify();
  beforeAll(async () => {
    await app.register(applicationFaviconRoutes);
    await app.ready();
  });
  afterAll(() => app.close());

  it("401 when not authenticated, 403 for a regular user", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    expect(
      (await app.inject({ method: "GET", url: "/favicon?url=https://a.b" }))
        .statusCode,
    ).toBe(401);
    mockGetSession.mockResolvedValueOnce({ user: { id: "u", role: "user" } });
    expect(
      (await app.inject({ method: "GET", url: "/favicon?url=https://a.b" }))
        .statusCode,
    ).toBe(403);
  });

  it("200 with the detected icon", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "a", role: "admin" } });
    detectFavicon.mockResolvedValueOnce("https://a.b/favicon.ico");
    const res = await app.inject({
      method: "GET",
      url: "/favicon?url=https%3A%2F%2Fa.b",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ iconUrl: "https://a.b/favicon.ico" });
    expect(detectFavicon).toHaveBeenCalledWith("https://a.b");
  });

  it("200 with a null icon when nothing is found", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "a", role: "admin" } });
    detectFavicon.mockResolvedValueOnce(null);
    const res = await app.inject({ method: "GET", url: "/favicon?url=nope" });
    expect(res.json()).toEqual({ iconUrl: null });
  });
});
