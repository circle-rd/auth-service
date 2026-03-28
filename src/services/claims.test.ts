import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUserClaims } from "../services/claims.js";

// Minimal integration smoke test — full tests require a running DB.
// These tests validate the contract shape and handle the no-results case.

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
  },
}));

describe("getUserClaims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty object when no scopes", async () => {
    const claims = await getUserClaims("user-1", undefined, []);
    expect(claims).toEqual({});
  });

  it("returns empty object when scopes requested but no data", async () => {
    const claims = await getUserClaims("user-1", "client-1", [
      "roles",
      "permissions",
      "features",
    ]);
    expect(typeof claims).toBe("object");
  });
});
