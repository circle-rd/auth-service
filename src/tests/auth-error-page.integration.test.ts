/**
 * Integration test — the templated authentication-error page (/error) and the
 * refused-registration redirect that points at it.
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

describe("Auth error page (integration)", () => {
  let handle: AuthServerHandle;
  let dir: string;
  const mutable = config as unknown as { templatesDir: string | null };
  const originalDir = mutable.templatesDir;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "auth-error-"));
    mkdirSync(join(dir, "default"), { recursive: true });
    writeFileSync(
      join(dir, "default", "error.html"),
      "<h1><%= it.ERROR_HEADING %></h1><code><%= it.ERROR_CODE %></code><a href=\"<%= it.LOGIN_URL %>\">signin</a>",
    );
    mkdirSync(join(dir, "branded"), { recursive: true });
    writeFileSync(
      join(dir, "branded", "error.html"),
      "<p>branded error</p>",
    );
    mutable.templatesDir = dir;

    handle = await makeAuthServer();
    await cleanDb();
    await db.insert(applications).values([
      { name: "Open", slug: "open-app", allowRegister: true },
      { name: "Closed", slug: "closed-app", allowRegister: false },
    ]);
  });

  afterAll(async () => {
    mutable.templatesDir = originalDir;
    await handle.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders the error page with copy for a known code", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/error?error=REGISTRATION_CLOSED",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Registration is not available");
    expect(res.body).toContain("REGISTRATION_CLOSED");
  });

  it("falls back to neutral copy for an unknown code", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/error?error=whatever",
    });
    expect(res.body).toContain("Something went wrong");
  });

  it("honours a per-application error template", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/error?error=access_denied&client_id=branded",
    });
    expect(res.body).toContain("branded error");
  });

  it("refuses an open-redirect login parameter", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/error?error=access_denied&login=//evil.example.com",
    });
    expect(res.body).toContain('href="/login"');
  });

  it("refuses a backslash-escaped open-redirect login parameter", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/error?error=access_denied&login=/%5Cevil.example.com",
    });
    expect(res.body).toContain('href="/login"');
  });

  it("keeps an accepted relative login path", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/error?error=access_denied&login=%2Flogin%3Fclient_id%3Dclosed-app",
    });
    expect(res.body).toContain('href="/login?client_id=closed-app"');
  });

  it("redirects a refused registration to the error page", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/register?client_id=closed-app&redirectTo=/dash",
    });
    expect(res.statusCode).toBe(302);
    const location = String(res.headers.location);
    expect(location).toContain("/error?");
    expect(location).toContain("error=REGISTRATION_CLOSED");
    expect(location).toContain("client_id=closed-app");
  });

  it("still redirects a non-existent application registration to the error page", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/register?client_id=does-not-exist",
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain("error=REGISTRATION_CLOSED");
  });
});
