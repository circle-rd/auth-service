import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createTestApp } from "../tests/helpers/app.js";
import { appConfigRoutes } from "./app-config.js";

vi.mock("../db/index.js", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve([]);
  return { db: { select: () => chain } };
});

describe("app-config routes", () => {
  const app = createTestApp();

  beforeAll(async () => {
    await app.register(appConfigRoutes);
    await app.ready();
  });

  afterAll(() => app.close());

  it("returns global defaults (registration disabled) when no client_id", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      allowRegister: boolean;
      enabledSocialProviders: string[];
      emailVerificationEnabled: boolean;
    };
    expect(body.allowRegister).toBe(false);
    expect(Array.isArray(body.enabledSocialProviders)).toBe(true);
    // No SMTP transport is configured in this test environment.
    expect(body.emailVerificationEnabled).toBe(false);
  });

  it("returns APP_002 for an unknown client_id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/?client_id=does-not-exist",
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("APP_002");
  });
});
