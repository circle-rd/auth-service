import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshRuntimeConfig() {
  vi.resetModules();
  return import("./runtime-config.js");
}

describe("runtime-config origins", () => {
  let rc: Awaited<ReturnType<typeof freshRuntimeConfig>>;

  beforeEach(async () => {
    rc = await freshRuntimeConfig();
  });

  it("trusts the origin of a URL and ignores invalid input", () => {
    rc.addCorsOrigin("https://app.example.com/callback?x=1");
    rc.addCorsOrigin("not a url");
    rc.addCorsOrigin(null);

    expect(rc.trustedOrigins).toEqual(["https://app.example.com"]);
    expect([...rc.corsOrigins]).toEqual(["https://app.example.com"]);
  });

  it("withdraws an origin once its only registration is removed", () => {
    rc.addCorsOrigin("https://app.example.com");

    rc.removeCorsOrigin("https://app.example.com/other-path");

    expect(rc.trustedOrigins).toEqual([]);
    expect(rc.corsOrigins.size).toBe(0);
  });

  it("keeps an origin another application still uses", () => {
    rc.addCorsOrigin("https://shared.example.com/a");
    rc.addCorsOrigin("https://shared.example.com/b");

    rc.removeCorsOrigin("https://shared.example.com/a");
    expect(rc.corsOrigins.has("https://shared.example.com")).toBe(true);

    rc.removeCorsOrigin("https://shared.example.com/b");
    expect(rc.corsOrigins.has("https://shared.example.com")).toBe(false);
  });

  it("keeps an origin listed in CORS_ORIGINS when an application using it goes away", () => {
    rc.addCorsOrigin("https://static.example.com");
    rc.addCorsOrigin("https://static.example.com/app");

    rc.removeCorsOrigin("https://static.example.com/app");

    expect(rc.trustedOrigins).toEqual(["https://static.example.com"]);
    expect(rc.corsOrigins.has("https://static.example.com")).toBe(true);
  });

  it("ignores the removal of an origin that was never registered", () => {
    rc.addCorsOrigin("https://kept.example.com");

    rc.removeCorsOrigin("https://never.example.com");

    expect(rc.trustedOrigins).toEqual(["https://kept.example.com"]);
  });
});
