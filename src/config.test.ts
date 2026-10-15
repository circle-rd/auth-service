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
