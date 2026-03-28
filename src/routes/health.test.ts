import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { healthRoutes } from "../routes/health.js";

describe("GET /health", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(healthRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  it("returns 200 with status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
  });
});
