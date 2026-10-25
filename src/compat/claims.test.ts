import { describe, it, expect } from "vitest";
import { applyClaimMappings } from "./claims.js";
import type { ClaimMapping } from "./profiles.js";

const OKTA: ClaimMapping[] = [
  { claim: "groups", source: "roles", scope: "groups" },
  { claim: "scp", source: "scope" },
  { claim: "preferred_username", source: "email", scope: "profile" },
  { claim: "cid", source: "clientId" },
];

/** Stand-in for getUserClaims: emits only what the scopes ask for. */
const build = (scopes: string[]) =>
  Promise.resolve({
    ...(scopes.includes("roles") ? { roles: ["editor"] } : {}),
    ...(scopes.includes("permissions") ? { permissions: ["docs"] } : {}),
    ...(scopes.includes("email")
      ? { email: "a@example.com", email_verified: true }
      : {}),
    ...(scopes.includes("profile") ? { name: "Alice" } : {}),
  });

describe("applyClaimMappings", () => {
  it("returns the native claims untouched without any mapping", async () => {
    const out = await applyClaimMappings([], ["openid", "roles"], "app", build);
    expect(out).toEqual({ roles: ["editor"] });
  });

  it("maps the sources and drops the native claims it had to compute", async () => {
    const out = await applyClaimMappings(
      OKTA,
      ["openid", "profile", "groups"],
      "my-app",
      build,
    );
    expect(out).toEqual({
      name: "Alice",
      groups: ["editor"],
      scp: ["openid", "profile", "groups"],
      preferred_username: "a@example.com",
      cid: "my-app",
    });
  });

  it("keeps the native claims the client asked for", async () => {
    const out = await applyClaimMappings(
      OKTA,
      ["openid", "profile", "email", "roles", "groups"],
      "my-app",
      build,
    );
    expect(out).toMatchObject({
      roles: ["editor"],
      email: "a@example.com",
      groups: ["editor"],
    });
  });

  it("skips a mapping whose trigger scope was not requested", async () => {
    const out = await applyClaimMappings(OKTA, ["openid"], "my-app", build);
    expect(out).not.toHaveProperty("groups");
    expect(out).not.toHaveProperty("preferred_username");
    expect(out).toMatchObject({ scp: ["openid"], cid: "my-app" });
  });

  it("never drops a claim that a mapping writes to", async () => {
    const out = await applyClaimMappings(
      [{ claim: "email", source: "email", scope: "profile" }],
      ["openid", "profile"],
      undefined,
      build,
    );
    expect(out).toMatchObject({ email: "a@example.com" });
  });
});
