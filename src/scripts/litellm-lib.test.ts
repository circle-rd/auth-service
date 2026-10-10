import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPkcePair,
  decodeJwtClaims,
  generateSecret,
  replaceEnvValue,
  upsertEnvValue,
} from "./litellm-lib.js";

describe("upsertEnvValue", () => {
  it("appends a missing key on its own line", () => {
    expect(upsertEnvValue("A=1", "B", "2")).toBe("A=1\nB=2\n");
    expect(upsertEnvValue("A=1\n", "B", "2")).toBe("A=1\nB=2\n");
    expect(upsertEnvValue("", "B", "2")).toBe("B=2\n");
  });

  it("fills an empty assignment in place", () => {
    expect(upsertEnvValue("A=1\nB=\nC=3\n", "B", "2")).toBe("A=1\nB=2\nC=3\n");
  });

  it("never overwrites an existing value", () => {
    const content = "B=existing\n";
    expect(upsertEnvValue(content, "B", "new")).toBe(content);
  });

  it("ignores commented-out assignments", () => {
    expect(upsertEnvValue("# B=old\n", "B", "2")).toBe("# B=old\nB=2\n");
  });

  it("does not match a key that merely ends with the name", () => {
    expect(upsertEnvValue("XB=1\n", "B", "2")).toBe("XB=1\nB=2\n");
  });
});

describe("replaceEnvValue", () => {
  it("overwrites an existing value, empty or not", () => {
    expect(replaceEnvValue("A=1\nB=old\nC=3\n", "B", "new")).toBe(
      "A=1\nB=new\nC=3\n",
    );
    expect(replaceEnvValue("B=\n", "B", "new")).toBe("B=new\n");
  });

  it("appends a missing key", () => {
    expect(replaceEnvValue("A=1", "B", "2")).toBe("A=1\nB=2\n");
    expect(replaceEnvValue("", "B", "2")).toBe("B=2\n");
  });

  it("leaves other keys with the same suffix alone", () => {
    expect(replaceEnvValue("XB=1\n", "B", "2")).toBe("XB=1\nB=2\n");
  });
});

describe("generateSecret", () => {
  it("returns distinct prefixed hex secrets", () => {
    const a = generateSecret("sk-");
    expect(a).toMatch(/^sk-[0-9a-f]{64}$/);
    expect(generateSecret("sk-")).not.toBe(a);
  });
});

describe("createPkcePair", () => {
  it("derives the S256 challenge from the verifier", () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });
});

describe("decodeJwtClaims", () => {
  it("decodes the payload segment", () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: "u1", azp: "app" }),
    ).toString("base64url");
    expect(decodeJwtClaims(`h.${payload}.s`)).toEqual({
      sub: "u1",
      azp: "app",
    });
  });

  it("rejects a token that is not a JWT", () => {
    expect(() => decodeJwtClaims("opaque")).toThrow("not a JWT");
  });
});
