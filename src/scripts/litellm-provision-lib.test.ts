import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVISIONER_KEY_ALIAS,
  PROVISIONER_ROUTES,
  loadProvisionEnv,
  provisionKey,
  type ProvisionEnv,
} from "./litellm-provision-lib.js";

let env: ProvisionEnv;
let calls: Array<{ path: string; body: unknown; auth: string | null }>;
let answers: Record<string, { status: number; body: unknown }>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  env = {
    gatewayUrl: "http://gw:4000",
    keyFile: join(dir, "sub", "key"),
    stateFile: join(dir, "secrets.env"),
  };
  writeFileSync(env.stateFile, "A=1\nLITELLM_MASTER_KEY=sk-master\n");
  calls = [];
  answers = {
    "/user/new": { status: 200, body: {} },
    "/key/delete": { status: 200, body: {} },
    "/key/generate": { status: 200, body: { key: "sk-new" } },
    "/team/list": { status: 401, body: {} },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("http://gw:4000", "");
      calls.push({
        path,
        body: init.body ? JSON.parse(init.body as string) : undefined,
        auth: new Headers(init.headers).get("Authorization"),
      });
      const a = answers[path]!;
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provisionKey", () => {
  it("creates an administrator-owned key limited to the team routes", async () => {
    expect(await provisionKey(env)).toBe("created");
    expect(readFileSync(env.keyFile, "utf8")).toBe("sk-new\n");
    const gen = calls.find((c) => c.path === "/key/generate")!;
    expect(gen.auth).toBe("Bearer sk-master");
    expect(gen.body).toEqual({
      user_id: "auth-service-provisioner",
      key_alias: PROVISIONER_KEY_ALIAS,
      allowed_routes: PROVISIONER_ROUTES,
    });
    expect(calls.find((c) => c.path === "/user/new")!.body).toMatchObject({
      user_role: "proxy_admin",
    });
    expect(PROVISIONER_ROUTES.every((r) => r.startsWith("/team/"))).toBe(true);
  });

  it("keeps a key that still works", async () => {
    await provisionKey(env);
    calls.length = 0;
    answers["/team/list"] = { status: 200, body: [] };
    expect(await provisionKey(env)).toBe("kept");
    expect(calls.map((c) => c.path)).toEqual(["/team/list"]);
  });

  it("replaces a key that no longer works, revoking the old one first", async () => {
    await provisionKey(env);
    calls.length = 0;
    answers["/key/generate"] = { status: 200, body: { key: "sk-newer" } };
    expect(await provisionKey(env)).toBe("created");
    expect(calls.map((c) => c.path)).toEqual([
      "/team/list",
      "/user/new",
      "/key/delete",
      "/key/generate",
    ]);
    expect(readFileSync(env.keyFile, "utf8")).toBe("sk-newer\n");
  });

  it("accepts an owner that already exists, refuses other failures", async () => {
    answers["/user/new"] = {
      status: 400,
      body: { error: "User already exists" },
    };
    expect(await provisionKey(env)).toBe("created");
    answers["/user/new"] = { status: 500, body: { error: "boom" } };
    await expect(provisionKey(env)).rejects.toThrow(/user creation failed/);
  });

  it("fails loud without the master key", async () => {
    writeFileSync(env.stateFile, "A=1\n");
    await expect(provisionKey(env)).rejects.toThrow(
      /LITELLM_MASTER_KEY not found/,
    );
  });
});

describe("loadProvisionEnv", () => {
  it("requires every variable and trims the trailing slash", () => {
    expect(() => loadProvisionEnv({})).toThrow(/LITELLM_URL/);
    expect(
      loadProvisionEnv({
        LITELLM_URL: "http://litellm:4000/",
        LITELLM_PROVISIONER_KEY_FILE: "/k",
        LITELLM_STATE_FILE: "/s",
      }).gatewayUrl,
    ).toBe("http://litellm:4000");
  });
});
