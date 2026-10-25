import { describe, it, expect } from "vitest";
import { buildAliasTable, resolveAlias } from "./aliases.js";

describe("resolveAlias", () => {
  const okta = buildAliasTable(["okta"]);
  const auth0 = buildAliasTable(["auth0"]);

  it("maps the Okta endpoints of the default and org authorization servers", () => {
    expect(resolveAlias("/oauth2/default/v1/token", okta)).toBe(
      "/api/auth/oauth2/token",
    );
    expect(resolveAlias("/oauth2/v1/keys", okta)).toBe("/api/auth/jwks");
    expect(resolveAlias("/oauth2/default/v1/logout", okta)).toBe(
      "/api/auth/oauth2/end-session",
    );
  });

  it("maps the Auth0 endpoints", () => {
    expect(resolveAlias("/oauth/token", auth0)).toBe("/api/auth/oauth2/token");
    expect(resolveAlias("/authorize", auth0)).toBe(
      "/api/auth/oauth2/authorize",
    );
    expect(resolveAlias("/.well-known/jwks.json", auth0)).toBe(
      "/api/auth/jwks",
    );
  });

  it("carries the query string over untouched", () => {
    expect(
      resolveAlias("/authorize?client_id=a&scope=openid%20email", auth0),
    ).toBe("/api/auth/oauth2/authorize?client_id=a&scope=openid%20email");
  });

  it("only matches exact paths", () => {
    for (const url of [
      "/oauth/token/",
      "/oauth/token/extra",
      "/authorize/../api/admin/users",
      "/OAUTH/token",
      "/x/oauth/token",
      "/api/admin/users",
      "",
    ]) {
      expect(resolveAlias(url, auth0)).toBeUndefined();
    }
    expect(resolveAlias("/oauth/token", okta)).toBeUndefined();
  });

  it("does nothing without an enabled set", () => {
    expect(resolveAlias("/oauth/token", buildAliasTable([]))).toBeUndefined();
    expect(resolveAlias(undefined, auth0)).toBeUndefined();
  });

  it("never targets anything outside the OAuth endpoints", () => {
    for (const set of [okta, auth0]) {
      for (const target of set.values()) {
        expect(target).toMatch(/^\/api\/auth\/(oauth2\/[a-z-]+|jwks)$/);
      }
    }
  });
});
