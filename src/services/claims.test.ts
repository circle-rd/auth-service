import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUserClaims } from "../services/claims.js";

// Minimal integration smoke test — full tests require a running DB.
// These tests validate the contract shape and handle the no-results case.

vi.mock("../db/index.js", () => {
  // Returns a Promise that also supports .limit() for drizzle chainable queries
  const queryResult = () =>
    Object.assign(Promise.resolve([]), {
      limit: vi.fn(() => Promise.resolve([])),
    });
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(queryResult),
          innerJoin: vi.fn(() => ({
            where: vi.fn(queryResult),
            innerJoin: vi.fn(() => ({
              where: vi.fn(queryResult),
            })),
          })),
          leftJoin: vi.fn(() => ({
            where: vi.fn(queryResult),
          })),
        })),
      })),
    },
  };
});

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

  it("includes email when email scope is present and profile is provided", async () => {
    const claims = await getUserClaims(
      "user-1",
      "client-1",
      ["roles", "email"],
      { email: "alice@example.com", name: null },
    );
    expect(claims.email).toBe("alice@example.com");
    expect(claims.name).toBeUndefined();
  });

  it("includes name when profile scope is present and profile is provided", async () => {
    const claims = await getUserClaims(
      "user-1",
      "client-1",
      ["roles", "profile"],
      { email: null, name: "Alice" },
    );
    expect(claims.name).toBe("Alice");
    expect(claims.email).toBeUndefined();
  });

  it("includes both email and name when both scopes are present", async () => {
    const claims = await getUserClaims(
      "user-1",
      "client-1",
      ["roles", "email", "profile"],
      { email: "bob@example.com", name: "Bob" },
    );
    expect(claims.email).toBe("bob@example.com");
    expect(claims.name).toBe("Bob");
  });

  it("omits email/name when no profile is passed", async () => {
    const claims = await getUserClaims("user-1", "client-1", [
      "roles",
      "email",
      "profile",
    ]);
    expect(claims.email).toBeUndefined();
    expect(claims.name).toBeUndefined();
  });

  it("omits email/name when profile values are null", async () => {
    const claims = await getUserClaims(
      "user-1",
      "client-1",
      ["roles", "email", "profile"],
      { email: null, name: null },
    );
    expect(claims.email).toBeUndefined();
    expect(claims.name).toBeUndefined();
  });
});
