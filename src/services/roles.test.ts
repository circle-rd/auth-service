import { describe, expect, it } from "vitest";
import {
  canManageRole,
  DASHBOARD_ROLES,
  hasAnyRole,
  roleRank,
  rolesOf,
} from "./roles.js";

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

  it("ranks a list by its highest role, so a list cannot lower a privilege", () => {
    expect(roleRank("user,admin")).toBe(1);
    expect(roleRank("admin,superadmin")).toBe(2);
    expect(roleRank("unknown")).toBe(0);
    expect(canManageRole("admin", "user,admin")).toBe(false);
    expect(canManageRole("superadmin", "user,admin")).toBe(true);
  });

  it("keeps both dashboards admin-only for now", () => {
    expect(hasAnyRole("admin", DASHBOARD_ROLES.security)).toBe(true);
    expect(hasAnyRole("admin", DASHBOARD_ROLES.business)).toBe(true);
    expect(hasAnyRole("user", DASHBOARD_ROLES.security)).toBe(false);
  });
});
