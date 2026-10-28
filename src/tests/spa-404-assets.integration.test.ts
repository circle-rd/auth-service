/**
 * Integration test — SPA catch-all returns 404 for missing asset paths
 * (file extension or /assets/) and for unknown /.well-known/ documents, and the
 * SPA shell for extensionless deep links.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";

describe("SPA not-found handler — asset paths vs deep links", () => {
  let handle: AuthServerHandle;
  // A private build directory: the real `frontend-dist` of the checkout is never
  // written or removed, and parallel test files never see a stand-in shell.
  const frontendDist = mkdtempSync(join(tmpdir(), "spa-dist-"));

  beforeAll(async () => {
    writeFileSync(join(frontendDist, "index.html"), "<!doctype html><title>SPA</title>");
    handle = await makeAuthServer({ frontendDist });
  });

  afterAll(async () => {
    await handle.cleanup();
    rmSync(frontendDist, { recursive: true, force: true });
  });

  it("returns 404 for a missing asset path with file extension", async () => {
    // A name the build never ships: a real favicon would be served, not missing.
    const res = await handle.app.inject({
      method: "GET",
      url: "/no-such-asset-404.ico",
    });
    // Should be 404 with SRV_001 JSON envelope, not 200 with index.html
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("SRV_001");
  });

  it("returns 404 for a missing /assets/ path", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/assets/does-not-exist.js",
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("SRV_001");
  });

  it("returns 404 for a missing .png path", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/does-not-exist.png",
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("SRV_001");
  });

  it("returns 404 JSON for a well-known document that is not offered", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("SRV_001");
  });

  it("returns 200 HTML for an extensionless deep link", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/some/spa/route",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("returns 200 HTML for the root path", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: "/",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});