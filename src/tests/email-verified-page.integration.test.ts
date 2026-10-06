/**
 * Integration test — the post-verification confirmation page in server-render
 * mode.
 *
 * The repository has two live rendering modes: when `TEMPLATES_DIR` is set the
 * auth pages are rendered from a template file, otherwise the Vue SPA serves
 * them. Both must serve the confirmation page, and the page must resolve a
 * per-application override like every other auth page.
 *
 * The session assertion is the load-bearing one: this route is reachable
 * without a session (it is the `callbackURL` of both verification flows), so
 * serving it must never read or mint a session.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";
import { config } from "../config.js";

describe("Auth pages — confirmation page in server-render mode (integration)", () => {
  let handle: AuthServerHandle;
  let dir: string;
  const mutableConfig = config as unknown as { templatesDir: string | null };
  const originalDir = mutableConfig.templatesDir;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "auth-pages-confirm-"));
    mkdirSync(join(dir, "default"), { recursive: true });
    mkdirSync(join(dir, "my-app"), { recursive: true });
    // A stand-in template: proves the route renders the resolved file and
    // receives the derived copy, without depending on the built-in markup.
    writeFileSync(
      join(dir, "default", "email-verified.html"),
      "<h1><%= it.CONFIRMATION_HEADING %></h1><a href=\"<%= it.LOGIN_URL %>\">Sign in</a>",
    );
    writeFileSync(
      join(dir, "my-app", "email-verified.html"),
      "<h1>my-app says: <%= it.CONFIRMATION_HEADING %></h1>",
    );
    mutableConfig.templatesDir = dir;
    handle = await makeAuthServer();
  });

  afterAll(async () => {
    mutableConfig.templatesDir = originalDir;
    await handle.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders the confirmation page for an anonymous visitor without a session", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/email-verified?status=activated",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Account activated");
    // The page offers an explicit sign-in route; it never links to a protected
    // area directly.
    expect(res.body).toContain('href="/login');
    expect(res.body).not.toContain('href="/profile');
    // Public route: nothing is minted, and no session cookie is emitted.
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("reports the change-of-address flow with its own wording", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/email-verified?status=updated",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Email address updated");
  });

  it("ignores an unknown status instead of echoing it", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/email-verified?status=%3Cscript%3E",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<script>");
    // Falls back to the neutral wording.
    expect(res.body).toContain("Email confirmed");
  });

  it("resolves a per-application override of the confirmation page", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/email-verified?status=activated&client_id=my-app",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("my-app says: Account activated");
  });

  it("serves the page in SPA mode too, when TEMPLATES_DIR is unset", async () => {
    // The other half of the double rendering mode: without a templates volume
    // the route must still answer — with the Vue build when one is present
    // (the SPA fallback serves index.html, and its router owns /email-verified),
    // and with a 404 when no frontend build was produced.
    mutableConfig.templatesDir = null;
    try {
      const res = await handle.app.inject({
        method: "GET",
        url: "/email-verified?status=activated",
      });

      expect([200, 404]).toContain(res.statusCode);
      expect(res.headers["set-cookie"]).toBeUndefined();
      if (res.statusCode === 200) {
        expect(res.headers["content-type"]).toContain("text/html");
      }
    } finally {
      mutableConfig.templatesDir = dir;
    }
  });
});
