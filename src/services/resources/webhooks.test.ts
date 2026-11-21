import { describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: { betterAuth: { secret: "test-secret-that-is-long-enough" } },
}));
vi.mock("../../db/index.js", () => ({ db: {} }));

const {
  decryptResourceWebhookSecret,
  encryptResourceWebhookSecret,
  generateResourceWebhookSecret,
  resourceWebhookUrlSchema,
} = await import("./webhooks.js");

describe("resource webhook secrets", () => {
  it("round-trips a generated secret", () => {
    const secret = generateResourceWebhookSecret();
    const stored = encryptResourceWebhookSecret(secret);
    expect(stored).not.toContain(secret);
    expect(decryptResourceWebhookSecret(stored)).toBe(secret);
  });

  it("refuses a malformed stored value", () => {
    expect(() => decryptResourceWebhookSecret("not-ciphertext")).toThrow(
      /malformed/i,
    );
  });

  it("refuses a tampered ciphertext", () => {
    const stored = encryptResourceWebhookSecret("secret");
    const parts = stored.split(".");
    const tampered = parts[2].slice(0, -2) + "AA";
    expect(() =>
      decryptResourceWebhookSecret([parts[0], parts[1], tampered].join(".")),
    ).toThrow();
  });
});

describe("resourceWebhookUrlSchema", () => {
  it("accepts an https URL", () => {
    expect(
      resourceWebhookUrlSchema.parse("https://gine.example.com/hook"),
    ).toBe("https://gine.example.com/hook");
  });

  it.each([
    "http://gine.example.com/hook",
    "https://user:pass@gine.example.com/hook",
    "https://gine.example.com/hook#fragment",
  ])("refuses %s", (value) => {
    expect(() => resourceWebhookUrlSchema.parse(value)).toThrow();
  });
});
