import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createTestApp } from "../tests/helpers/app.js";
import { consumptionRoutes } from "../routes/consumption.js";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));
vi.mock("../auth.js", () => ({
  auth: {
    api: {
      verifyAccessToken: vi
        .fn()
        .mockResolvedValue({ token: { sub: "user-1" } }),
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));
vi.mock("../db/index.js", () => ({ db: {} }));

describe("consumption routes – validation", () => {
  const app = createTestApp();

  beforeAll(async () => {
    await app.register(consumptionRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  it("POST / returns 400 when body is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: { authorization: "Bearer mock-token" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /:userId/:applicationId returns 400 (CONS_005) on non-uuid params", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/undefined/undefined",
      headers: { authorization: "Bearer mock-token" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("CONS_005");
  });

  it("GET /:userId/:applicationId/:key returns 400 on non-uuid params", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/not-a-uuid/also-bad/some.key",
      headers: { authorization: "Bearer mock-token" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("CONS_005");
  });
});
