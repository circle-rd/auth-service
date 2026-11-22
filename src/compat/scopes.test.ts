import { describe, expect, it } from "vitest";
import {
  NATIVE_SCOPES,
  ORGANIZATION_SELF_SCOPE,
  RESOURCE_SELF_SCOPE,
  withResourceSharingScope,
  withTeamsScope,
} from "./scopes.js";

describe("application-owned user scopes", () => {
  it("declares the teams scope as a native scope", () => {
    expect(NATIVE_SCOPES).toContain(ORGANIZATION_SELF_SCOPE);
    expect(ORGANIZATION_SELF_SCOPE).toBe("organizations:self:manage");
  });

  it("adds the teams scope once when the flag is on", () => {
    expect(withTeamsScope(["openid"], true)).toEqual([
      "openid",
      ORGANIZATION_SELF_SCOPE,
    ]);
    expect(withTeamsScope(["openid", ORGANIZATION_SELF_SCOPE], true)).toEqual([
      "openid",
      ORGANIZATION_SELF_SCOPE,
    ]);
  });

  it("removes the teams scope when the flag is off", () => {
    expect(withTeamsScope(["openid", ORGANIZATION_SELF_SCOPE], false)).toEqual([
      "openid",
    ]);
  });

  it("does not touch the resource scope in either direction", () => {
    expect(withTeamsScope([RESOURCE_SELF_SCOPE], true)).toEqual([
      RESOURCE_SELF_SCOPE,
      ORGANIZATION_SELF_SCOPE,
    ]);
    expect(withResourceSharingScope([ORGANIZATION_SELF_SCOPE], false)).toEqual([
      ORGANIZATION_SELF_SCOPE,
    ]);
  });
});
