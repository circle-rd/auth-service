import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { consumptionRoutes } from "../routes/consumption.js";

vi.mock("../auth.js", () => ({
  auth: {
    api: {
      verifyAccessToken: vi
        .fn()
        .mockResolvedValue({ token: { sub: "user-1" } }),
    },
  },
}));
vi.mock("../db/index.js", () => ({ db: {} }));

describe("consumption routes – validation", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(consumptionRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  it("POST /api/consumption returns 400 when body is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/consumption",
      headers: { authorization: "Bearer mock-token" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
