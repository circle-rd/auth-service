import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Regression tests for the environment-flag parsing. Historically
 * `z.coerce.boolean()` turned the string "false" into `true`, silently
 * enabling the magic-link / email-OTP flows and disabling email verification.
 */

const BASE_ENV: Record<string, string> = {
  BETTER_AUTH_SECRET: "test-secret-that-is-long-enough",
  BETTER_AUTH_URL: "http://localhost:3001",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  SMTP_HOST: "localhost",
};

const FLAG_KEYS = [
  "MAGIC_LINK_ENABLED",
  "EMAIL_OTP_ENABLED",
  "REQUIRE_EMAIL_VERIFICATION",
  "NODE_ENV",
  "APP_LOGO_URL",
  "APP_LOGO_DARK_URL",
  "COMPAT_PROFILE",
  "TOKEN_ENDPOINT_AUTH_METHOD",
  "JWT_PRIMARY_ALG",
  "DEFAULT_AUDIENCE",
  "AUDIENCE_PARAM",
  "CLAIM_MAPPINGS",
  "COMPAT_ALIASES",
  "TRUST_PROXY",
  "TRUST_PROXY_HOPS",
  "LOG_SQL",
];

async function loadConfig(overrides: Record<string, string>) {
  vi.resetModules();
  for (const key of FLAG_KEYS) delete process.env[key];
  Object.assign(process.env, BASE_ENV, overrides);
  return (await import("./config.js")).config;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("config environment flags", () => {
  it("reads MAGIC_LINK_ENABLED=false as false", async () => {
    const config = await loadConfig({
      NODE_ENV: "test",
      MAGIC_LINK_ENABLED: "false",
    });
    expect(config.email.magicLinkEnabled).toBe(false);
  });

  it("reads EMAIL_OTP_ENABLED=false as false", async () => {
    const config = await loadConfig({
      NODE_ENV: "test",
      EMAIL_OTP_ENABLED: "false",
    });
    expect(config.email.otpEnabled).toBe(false);
  });

  it("reads the true spellings as true", async () => {
    const config = await loadConfig({
      NODE_ENV: "test",
      MAGIC_LINK_ENABLED: "true",
      EMAIL_OTP_ENABLED: "1",
    });
    expect(config.email.magicLinkEnabled).toBe(true);
    expect(config.email.otpEnabled).toBe(true);
  });

  it("honours an explicit REQUIRE_EMAIL_VERIFICATION=false in production", async () => {
    const config = await loadConfig({
      NODE_ENV: "production",
      REQUIRE_EMAIL_VERIFICATION: "false",
    });
    expect(config.email.requireVerification).toBe(false);
  });

  it("falls back to the production default when REQUIRE_EMAIL_VERIFICATION is empty", async () => {
    const config = await loadConfig({
      NODE_ENV: "production",
      REQUIRE_EMAIL_VERIFICATION: "",
    });
    expect(config.email.requireVerification).toBe(true);
  });

  it("rejects LOG_SQL in production", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(
      loadConfig({ NODE_ENV: "production", LOG_SQL: "true" }),
    ).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join(" ")).toContain("LOG_SQL");
  });
});

describe("config logo variants", () => {
  it("accepts a dark logo alongside the light one", async () => {
    const config = await loadConfig({
      NODE_ENV: "test",
      APP_LOGO_URL: "https://example.com/logo.png",
      APP_LOGO_DARK_URL: "https://example.com/logo-dark.png",
    });
    expect(config.appLogoDarkUrl).toBe("https://example.com/logo-dark.png");
  });

  it("rejects a dark logo without the light one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(
      loadConfig({
        NODE_ENV: "test",
        APP_LOGO_DARK_URL: "https://example.com/logo-dark.png",
      }),
    ).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("config compatibility profile", () => {
  it("defaults to the current behaviour", async () => {
    const config = await loadConfig({ NODE_ENV: "test" });
    expect(config.compat).toMatchObject({
      profile: "default",
      tokenAuthMethod: "basic",
      signingAlg: "ES256",
      defaultAudience: false,
    });
  });

  it("applies a profile and lets an explicit variable override it", async () => {
    const config = await loadConfig({
      NODE_ENV: "test",
      COMPAT_PROFILE: "okta",
      TOKEN_ENDPOINT_AUTH_METHOD: "post",
      DEFAULT_AUDIENCE: "false",
    });
    expect(config.compat).toMatchObject({
      profile: "okta",
      tokenAuthMethod: "post",
      signingAlg: "RS256",
      defaultAudience: false,
    });
  });

  it("reads custom claim mappings and aliases", async () => {
    const config = await loadConfig({
      NODE_ENV: "test",
      COMPAT_PROFILE: "custom",
      CLAIM_MAPPINGS: '[{"claim":"https://a.example/roles","source":"roles"}]',
      COMPAT_ALIASES: "okta, auth0",
    });
    expect(config.compat.claimMappings).toEqual([
      { claim: "https://a.example/roles", source: "roles" },
    ]);
    expect(config.compat.aliases).toEqual(["okta", "auth0"]);
  });

  it.each([
    ["COMPAT_PROFILE", "azure"],
    ["JWT_PRIMARY_ALG", "HS256"],
    ["JWT_PRIMARY_ALG", "EdDSA"],
    ["TOKEN_ENDPOINT_AUTH_METHOD", "none"],
    ["CLAIM_MAPPINGS", "not json"],
    ["CLAIM_MAPPINGS", '[{"claim":"sub","source":"roles"}]'],
    ["COMPAT_ALIASES", "okta,ping"],
    ["DEFAULT_AUDIENCE", "maybe"],
    ["TRUST_PROXY", "not-an-address"],
    ["TRUST_PROXY", "10.0.0.0/33"],
    ["TRUST_PROXY", "10.0.0.1,,10.0.0.2"],
    ["TRUST_PROXY", "0.0.0.0/0"],
    ["TRUST_PROXY", "::/0"],
    ["TRUST_PROXY", "10.0.0.0/00"],
    ["TRUST_PROXY", "  "],
    ["TRUST_PROXY_HOPS", "1"],
  ])("rejects an invalid %s", async (key, value) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(
      loadConfig({ NODE_ENV: "test", [key]: value }),
    ).rejects.toThrow("exit");
  });
});

describe("config TRUST_PROXY", () => {
  it("trusts no proxy by default", async () => {
    const config = await loadConfig({ NODE_ENV: "test" });
    expect(config.trustProxy).toEqual([]);
  });

  it("treats an empty value as unset", async () => {
    const config = await loadConfig({ NODE_ENV: "test", TRUST_PROXY: "" });
    expect(config.trustProxy).toEqual([]);
  });

  it("reads addresses, CIDR ranges and keywords", async () => {
    const config = await loadConfig({
      NODE_ENV: "test",
      TRUST_PROXY: "10.0.0.1, 172.16.0.0/12 ,fd00::/8,loopback",
    });
    expect(config.trustProxy).toEqual([
      "10.0.0.1",
      "172.16.0.0/12",
      "fd00::/8",
      "loopback",
    ]);
  });
});
