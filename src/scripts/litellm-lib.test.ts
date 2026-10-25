import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AuthAdminClient,
  TwoFactorRequiredError,
  isSetupComplete,
  createPkcePair,
  decodeJwtClaims,
  generateSecret,
  readEnvValue,
  removeEnvValue,
  replaceEnvValue,
  resolveSecret,
  shellQuote,
  ssoGatewayEnv,
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

  it("explains that an account with MFA cannot be used to sign in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const res = new Response(JSON.stringify({ twoFactorRedirect: true }));
        res.headers.append("Set-Cookie", "two_factor=abc; Path=/; HttpOnly");
        return res;
      }),
    );
    try {
      await expect(
        new AuthAdminClient("http://auth:3001").signIn(
          "admin@example.com",
          "pw",
        ),
      ).rejects.toBeInstanceOf(TwoFactorRequiredError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("isSetupComplete", () => {
  const complete = [
    "LITELLM_MASTER_KEY=sk-a",
    "LITELLM_SALT_KEY=sk-b",
    "LITELLM_WALLET_CLIENT_SECRET=w",
  ].join("\n");

  it("needs the SSO client secret only when the sign-in is on", () => {
    expect(isSetupComplete(complete, false)).toBe(true);
    expect(isSetupComplete(complete, true)).toBe(false);
    expect(isSetupComplete(`${complete}\nGENERIC_CLIENT_SECRET=s`, true)).toBe(
      true,
    );
  });

  it("is incomplete when a key is missing or empty", () => {
    expect(isSetupComplete("LITELLM_MASTER_KEY=sk-a", false)).toBe(false);
    expect(isSetupComplete(`${complete}\nGENERIC_CLIENT_SECRET=`, true)).toBe(
      false,
    );
  });
});

describe("shellQuote", () => {
  it("survives being sourced by sh, whatever it holds", () => {
    const values = [
      "plain",
      "openid profile email roles",
      '{"proxy_admin": ["admin"], "proxy_admin_viewer": ["user"]}',
      'it\'s a $HOME `trick` \\ "quoted"',
    ];
    const file = values.map((v, i) => `V${i}=${shellQuote(v)}`).join("\n");
    const script = values.map((_, i) => `printf '%s\\0' "$V${i}"`).join(";");
    const out = execFileSync("sh", ["-c", `${file}\n${script}`], {
      encoding: "utf8",
    });
    expect(out.split("\0").slice(0, values.length)).toEqual(values);
  });
});

describe("ssoGatewayEnv", () => {
  const urls = {
    gatewayPublicUrl: "https://llm.example.com/",
    authPublicUrl: "https://auth.example.com/",
    authInternalUrl: "http://auth-service:3001",
  };

  it("sends the browser to the public auth-service and the gateway to the internal one", () => {
    const env = ssoGatewayEnv(urls);
    expect(env.GENERIC_AUTHORIZATION_ENDPOINT).toBe(
      "https://auth.example.com/api/auth/oauth2/authorize",
    );
    expect(env.GENERIC_TOKEN_ENDPOINT).toBe(
      "http://auth-service:3001/api/auth/oauth2/token",
    );
    expect(env.GENERIC_USERINFO_ENDPOINT).toBe(
      "http://auth-service:3001/api/auth/oauth2/userinfo",
    );
    expect(env.PROXY_BASE_URL).toBe("https://llm.example.com");
  });

  it("redirects the login page to the SSO and maps the roles", () => {
    const env = ssoGatewayEnv(urls);
    expect(env.AUTO_REDIRECT_UI_LOGIN_TO_SSO).toBe("true");
    expect(env.GENERIC_CLIENT_USE_PKCE).toBe("true");
    expect(JSON.parse(env.GENERIC_ROLE_MAPPINGS_ROLES!)).toEqual({
      proxy_admin: ["admin"],
      proxy_admin_viewer: ["user"],
    });
  });

  it("round-trips through a state file written the way litellm-setup writes it", () => {
    let content = "LITELLM_MASTER_KEY=sk-abc\n";
    for (const [key, value] of Object.entries(ssoGatewayEnv(urls))) {
      content = replaceEnvValue(content, key, shellQuote(value));
    }
    // A second run rewrites in place instead of duplicating.
    for (const [key, value] of Object.entries(ssoGatewayEnv(urls))) {
      content = replaceEnvValue(content, key, shellQuote(value));
    }
    expect(content.match(/^GENERIC_SCOPE=/gm)).toHaveLength(1);
    const out = execFileSync(
      "sh",
      [
        "-c",
        `${content}\nprintf '%s' "$GENERIC_SCOPE|$AUTO_REDIRECT_UI_LOGIN_TO_SSO"`,
      ],
      { encoding: "utf8" },
    );
    expect(out).toBe("openid profile email roles|true");
  });
});
