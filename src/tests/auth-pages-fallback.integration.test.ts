/**
 * Integration test — server-rendered auth pages fall back to the Vue SPA when a
 * template cannot be rendered, and the reason is logged instead of swallowed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";
import { config } from "../config.js";

describe("Auth pages — template render failure (integration)", () => {
  let handle: AuthServerHandle;
  let dir: string;
  const mutableConfig = config as unknown as { templatesDir: string | null };
  const originalDir = mutableConfig.templatesDir;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "auth-pages-fail-"));
    mkdirSync(join(dir, "default"), { recursive: true });
    // Eta compile error: an unterminated tag makes the render throw.
    writeFileSync(join(dir, "default", "login.html"), "<p><%= it.X </p>");
    mutableConfig.templatesDir = dir;
    handle = await makeAuthServer();
  });

  afterAll(async () => {
    mutableConfig.templatesDir = originalDir;
    await handle.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs a warning with the page name and never serves the broken template", async () => {
    const warn = vi.spyOn(handle.app.log, "warn");

    const res = await handle.app.inject({ method: "GET", url: "/login" });

    // Falls back to the SPA (or 404 when no frontend build is present).
    expect([200, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain("<p><%=");

    const call = warn.mock.calls.find((args) =>
      String(args[1] ?? "").includes("[templates]"),
    );
    expect(call).toBeDefined();
    const context = call![0] as { page: string; err: string };
    expect(context.page).toBe("login");
    expect(context.err.length).toBeGreaterThan(0);
  });
});
