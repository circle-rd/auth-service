/**
 * Integration test — the server-rendered /login page. An application's sign-in
 * (client_id) renders its template with the social providers it allows, so
 * third-party logins keep working; the service's own sign-in (no client_id) is
 * the SPA's login page, not a template.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";

type Providers = Record<string, { enabled: boolean }>;

describe("Login page social providers (integration)", () => {
  let handle: AuthServerHandle;
  let dir: string;
  const mutable = config as unknown as {
    templatesDir: string | null;
    providers: Providers;
  };
  const originalDir = mutable.templatesDir;
  const originalProviders = mutable.providers;

  const providersOf = async (query: string): Promise<string[]> => {
    const res = await handle.app.inject({ method: "GET", url: `/login${query}` });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body.trim()) as string[];
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "login-social-"));
    mkdirSync(join(dir, "default"), { recursive: true });
    writeFileSync(join(dir, "default", "login.html"), "<%~ it.SOCIAL_PROVIDERS_JSON %>");
    mutable.templatesDir = dir;
    mutable.providers = {
      ...originalProviders,
      google: { ...originalProviders.google, enabled: true },
      github: { ...originalProviders.github, enabled: true },
    };
    handle = await makeAuthServer();
    await cleanDb();
    await db.insert(applications).values([
      { name: "Inherits", slug: "inherits", enabledSocialProviders: null },
      { name: "Github only", slug: "github-only", enabledSocialProviders: ["github"] },
      { name: "No social", slug: "no-social", enabledSocialProviders: [] },
    ]);
  });

  afterAll(async () => {
    mutable.templatesDir = originalDir;
    mutable.providers = originalProviders;
    await handle.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the service's own sign-in (no client_id) from the SPA, never the application template", async () => {
    for (const query of ["", "?redirectTo=/profile"]) {
      const res = await handle.app.inject({ method: "GET", url: `/login${query}` });
      // The SPA build is absent from the test environment (404); when present it
      // is HTML. Either way it is not the rendered template.
      expect(res.body).not.toContain("google");
      expect(res.body.trim()).not.toBe("[]");
    }
  });

  it("offers an application the providers it allows", async () => {
    expect(await providersOf("?client_id=inherits")).toEqual(["google", "github"]);
    expect(await providersOf("?client_id=github-only")).toEqual(["github"]);
    expect(await providersOf("?client_id=no-social")).toEqual([]);
  });

  it("offers none for an unknown client_id", async () => {
    expect(await providersOf("?client_id=does-not-exist")).toEqual([]);
  });
});
