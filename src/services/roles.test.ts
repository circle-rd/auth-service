import { describe, expect, it } from "vitest";
import { DASHBOARD_ROLES, hasAnyRole, rolesOf } from "./roles.js";

describe("role lists", () => {
  it("splits a comma-separated role string", () => {
    expect(rolesOf("admin, auditor")).toEqual(["admin", "auditor"]);
    expect(rolesOf("")).toEqual([]);
    expect(rolesOf(null)).toEqual([]);
  });

  it("matches on whole roles only", () => {
    expect(hasAnyRole("superadmin", ["admin"])).toBe(false);
    expect(hasAnyRole("user,admin", ["admin"])).toBe(true);
    expect(hasAnyRole(undefined, ["admin"])).toBe(false);
  });

  it("keeps both dashboards admin-only for now", () => {
    expect(hasAnyRole("admin", DASHBOARD_ROLES.security)).toBe(true);
    expect(hasAnyRole("admin", DASHBOARD_ROLES.business)).toBe(true);
    expect(hasAnyRole("user", DASHBOARD_ROLES.security)).toBe(false);
  });
});
