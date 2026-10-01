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
