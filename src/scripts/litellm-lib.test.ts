import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPkcePair,
  decodeJwtClaims,
  generateSecret,
  readEnvValue,
  replaceEnvValue,
  resolveSecret,
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

describe("resolveSecret", () => {
  const gen = () => "generated";

  it("generates a secret nobody has set", () => {
    expect(resolveSecret("", "K", undefined, gen)).toEqual({
      content: "K=generated\n",
      action: "generated",
    });
  });

  it("treats an empty assignment as unset", () => {
    expect(resolveSecret("K=\n", "K", "", gen).action).toBe("generated");
  });

  it("keeps a stored secret rather than regenerating it", () => {
    expect(resolveSecret("K=stored\n", "K", undefined, gen)).toEqual({
      content: "K=stored\n",
      action: "kept",
    });
  });

  it("stores a value supplied by the operator", () => {
    expect(resolveSecret("", "K", "mine", gen)).toEqual({
      content: "K=mine\n",
      action: "supplied",
    });
  });

  it("lets a supplied value replace a different stored one", () => {
    expect(resolveSecret("K=old\n", "K", "new", gen)).toEqual({
      content: "K=new\n",
      action: "replaced",
    });
  });

  it("does nothing when the supplied value is the stored one", () => {
    expect(resolveSecret("K=same\n", "K", "same", gen).action).toBe("kept");
  });
});

describe("readEnvValue", () => {
  it("reads a value and ignores empty, missing and commented keys", () => {
    expect(readEnvValue("A=1\nB=\n# C=3\n", "A")).toBe("1");
    expect(readEnvValue("A=1\nB=\n# C=3\n", "B")).toBeUndefined();
    expect(readEnvValue("A=1\nB=\n# C=3\n", "C")).toBeUndefined();
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
