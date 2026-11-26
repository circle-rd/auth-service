import { describe, expect, it } from "vitest";
import { hashOpaqueToken } from "./oauth-tokens.js";
import {
  GATEWAY_KEY_RE,
  generateGatewayKey,
  hashGatewayKey,
  maskGatewayKey,
  resolveGatewayKey,
} from "./gateway-keys.js";

describe("personal gateway key format", () => {
  it("generates cgk_ plus 32 random bytes in base64url", () => {
    const key = generateGatewayKey();
    expect(key).toHaveLength(47);
    expect(key.startsWith("cgk_")).toBe(true);
    expect(GATEWAY_KEY_RE.test(key)).toBe(true);
    expect(generateGatewayKey()).not.toBe(key);
  });

  it("rejects keys that do not match the format", () => {
    for (const value of [
      "",
      "cgk_short",
      `sk_${"A".repeat(43)}`,
      `cgk_${"A".repeat(42)}`,
      `cgk_${"A".repeat(43)}A`,
      `cgk_${"!".repeat(43)}`,
    ]) {
      expect(GATEWAY_KEY_RE.test(value)).toBe(false);
    }
  });

  it("stores only the shared opaque-token hash", () => {
    const key = generateGatewayKey();
    expect(hashGatewayKey(key)).toBe(hashOpaqueToken(key));
    expect(hashGatewayKey(key)).toHaveLength(43);
    expect(hashGatewayKey(key)).not.toContain("cgk_");
  });

  it("masks a key without exposing its middle", () => {
    const key = generateGatewayKey();
    const masked = maskGatewayKey(key);
    expect(masked).toBe(`${key.slice(0, 10)}…${key.slice(-4)}`);
    expect(masked).not.toBe(key);
  });
});

describe("personal gateway key resolution", () => {
  it("refuses a malformed key before reading the database", async () => {
    await expect(resolveGatewayKey("not-a-key")).rejects.toMatchObject({
      code: "KEY_001",
      statusCode: 401,
    });
  });
});
