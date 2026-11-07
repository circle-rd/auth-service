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

  it("derives standard profile claims from the user name and email", async () => {
    const claims = await getUserClaims(
      "user-1",
      "client-1",
      ["profile", "email"],
      {
        email: "alice@example.com",
        emailVerified: true,
        name: "Alice Smith",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    );

    expect(claims).toMatchObject({
      name: "Alice Smith",
      given_name: "Alice",
      family_name: "Smith",
      nickname: "Alice",
      preferred_username: "alice",
      updated_at: 1767225600,
      email: "alice@example.com",
      email_verified: true,
    });
    // Claims we cannot truthfully derive are omitted, not sent as nulls.
    expect(claims).not.toHaveProperty("middle_name");
    expect(claims).not.toHaveProperty("picture");
    expect(claims).not.toHaveProperty("phone_number");
  });

  it("emits optional OIDC profile claims when supplied", async () => {
    const claims = await getUserClaims("user-1", "client-1", ["profile"], {
      name: "Alice Smith",
      firstName: "Alice",
      lastName: "Smith",
      username: "asmith",
      middleName: "B.",
      profileUrl: "https://example.com/alice",
      website: "https://alice.example",
      gender: "female",
      birthdate: "1990-01-31",
      zoneinfo: "Europe/Paris",
      locale: "fr-FR",
    });

    expect(claims).toMatchObject({
      middle_name: "B.",
      profile: "https://example.com/alice",
      website: "https://alice.example",
      gender: "female",
      birthdate: "1990-01-31",
      zoneinfo: "Europe/Paris",
      locale: "fr-FR",
    });
  });

  it("only emits phone claims when a phone number exists", async () => {
    const withPhone = await getUserClaims("user-1", "client-1", ["phone"], {
      phone: "+33612345678",
    });
    expect(withPhone).toMatchObject({
      phone_number: "+33612345678",
      phone_number_verified: false,
    });

    const withoutPhone = await getUserClaims("user-1", "client-1", ["phone"], {
      phone: null,
    });
    expect(withoutPhone).not.toHaveProperty("phone_number");
    expect(withoutPhone).not.toHaveProperty("phone_number_verified");
  });
});
