import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createTestApp } from "../tests/helpers/app.js";
import { config } from "../config.js";
import { appConfigRoutes, socialProvidersFor } from "./app-config.js";

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

  it("offers no social provider without a client_id, even when some are configured", async () => {
    const mutable = config as unknown as {
      providers: Record<string, { enabled: boolean }>;
    };
    const original = mutable.providers;
    mutable.providers = Object.fromEntries(
      Object.entries(original).map(([name, provider]) => [
        name,
        { ...provider, enabled: name === "google" || name === "github" },
      ]),
    );
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      const body = JSON.parse(res.body) as { enabledSocialProviders: string[] };
      expect(body.enabledSocialProviders).toEqual([]);
      expect(socialProvidersFor(null)).toEqual(["google", "github"]);
      expect(socialProvidersFor(["github", "apple"])).toEqual(["github"]);
      expect(socialProvidersFor(["apple"])).toEqual([]);
      expect(socialProvidersFor([])).toEqual([]);
    } finally {
      mutable.providers = original;
    }
  });

  it("returns defaults (registration disabled) when no client_id", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      allowRegister: boolean;
      enabledSocialProviders: string[];
      emailVerificationEnabled: boolean;
    };
    expect(body.allowRegister).toBe(false);
    expect(body.enabledSocialProviders).toEqual([]);
    // No SMTP transport is configured in this test environment.
    expect(body.emailVerificationEnabled).toBe(false);
  });

  it("exposes the showcase flag, off by default", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(JSON.parse(res.body)).toMatchObject({ showcase: false });
  });

  it("reports the showcase flag when enabled", async () => {
    const mutable = config as unknown as { showcase: boolean };
    mutable.showcase = true;
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(JSON.parse(res.body)).toMatchObject({ showcase: true });
    } finally {
      mutable.showcase = false;
    }
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
