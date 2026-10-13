import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AuthAdminClient,
  createPkcePair,
  decodeJwtClaims,
  generateSecret,
  readEnvValue,
  removeEnvValue,
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

describe("removeEnvValue", () => {
  it("drops the assignment and keeps the other lines", () => {
    expect(removeEnvValue("A=1\nB=2\nC=3\n", "B")).toBe("A=1\nC=3\n");
  });

  it("does nothing for a missing key or a key that only ends with the name", () => {
    expect(removeEnvValue("XB=1\n", "B")).toBe("XB=1\n");
    expect(removeEnvValue("A=1\n", "B")).toBe("A=1\n");
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

describe("AuthAdminClient session", () => {
  it("signs out the session it opened, naming itself in the user agent", async () => {
    const calls: {
      url: string;
      cookie: string | null;
      agent: string | null;
    }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      calls.push({
        url,
        cookie: headers.get("Cookie"),
        agent: headers.get("User-Agent"),
      });
      const res = new Response(JSON.stringify({ user: { id: "admin-1" } }));
      if (url.endsWith("/sign-in/email")) {
        res.headers.append("Set-Cookie", "session=abc; Path=/; HttpOnly");
      }
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new AuthAdminClient("http://auth:3001");
      await client.signIn("admin@example.com", "pw");
      await client.signOut();
      await client.signOut();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calls.map((c) => c.url)).toEqual([
      "http://auth:3001/api/auth/sign-in/email",
      "http://auth:3001/api/auth/sign-out",
    ]);
    expect(calls[1]!.cookie).toBe("session=abc");
    expect(calls.every((c) => c.agent === "auth-service-admin-script")).toBe(
      true,
    );
  });
});
