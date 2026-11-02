import { describe, expect, it } from "vitest";
import { jwksOptions, signingKeyPairConfig } from "./key-pair.js";

describe("signing key pairs", () => {
  it("creates P-256 keys for ES256", () => {
    expect(signingKeyPairConfig("ES256")).toEqual({ alg: "ES256" });
  });

  it("creates 2048-bit keys for RS256", () => {
    expect(signingKeyPairConfig("RS256")).toEqual({
      alg: "RS256",
      modulusLength: 2048,
    });
  });

  it("rotates monthly and keeps the previous key published for another month", () => {
    expect(jwksOptions("ES256")).toMatchObject({
      rotationInterval: 2_592_000,
      gracePeriod: 2_592_000,
    });
  });
});
