import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVISIONER_KEY_ALIAS,
  PROVISIONER_ROUTES,
  RESOURCE_SYNC_KEY_ALIAS,
  RESOURCE_SYNC_ROUTES,
  loadProvisionEnv,
  provisionKey,
  provisionKeys,
  provisionResourceSyncKey,
  type ProvisionEnv,
} from "./litellm-provision-lib.js";

let env: ProvisionEnv;
let calls: Array<{ path: string; body: unknown; auth: string | null }>;
let answers: Record<string, Array<{ status: number; body: unknown }>>;

function answer(path: string): { status: number; body: unknown } {
  const queue = answers[path];
  if (!queue || queue.length === 0) return { status: 403, body: {} };
  return queue.length > 1 ? queue.shift()! : queue[0]!;
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  env = {
    gatewayUrl: "http://gw:4000",
    keyFile: join(dir, "sub", "key"),
    resourceSyncKeyFile: join(dir, "sub", "resource-sync-key"),
    stateFile: join(dir, "secrets.env"),
  };
  writeFileSync(env.stateFile, "A=1\nLITELLM_MASTER_KEY=sk-master\n");
  calls = [];
  answers = {
    "/user/new": [{ status: 200, body: {} }],
    "/key/delete": [{ status: 200, body: {} }],
    "/key/generate": [{ status: 200, body: { key: "sk-new" } }],
    "/v1/access_group": [{ status: 200, body: [] }],
    "/team/list": [{ status: 403, body: {} }],
    "/model/info": [{ status: 403, body: {} }],
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
      const a = answer(path);
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
    expect(
      PROVISIONER_ROUTES.every(
        (r) => r.startsWith("/team/") || r.startsWith("/v1/access_group"),
      ),
    ).toBe(true);
  });

  it("keeps a key that still works", async () => {
    await provisionKey(env);
    calls.length = 0;
    expect(await provisionKey(env)).toBe("kept");
    expect(calls.map((c) => c.path)).toEqual(["/v1/access_group"]);
  });

  it("replaces a key that no longer works, revoking the old one first", async () => {
    await provisionKey(env);
    calls.length = 0;
    answers["/v1/access_group"] = [
      { status: 401, body: {} },
      { status: 200, body: [] },
    ];
    answers["/key/generate"] = [{ status: 200, body: { key: "sk-newer" } }];
    expect(await provisionKey(env)).toBe("created");
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/access_group",
      "/user/new",
      "/key/delete",
      "/key/generate",
      "/v1/access_group",
    ]);
    expect(readFileSync(env.keyFile, "utf8")).toBe("sk-newer\n");
  });

  it("accepts an owner that already exists, refuses other failures", async () => {
    answers["/user/new"] = [
      { status: 400, body: { error: "User already exists" } },
    ];
    expect(await provisionKey(env)).toBe("created");
    rmSync(env.keyFile);
    answers["/user/new"] = [{ status: 500, body: { error: "boom" } }];
    await expect(provisionKey(env)).rejects.toThrow(/user creation failed/);
  });

  it("fails loud without the master key", async () => {
    writeFileSync(env.stateFile, "A=1\n");
    await expect(provisionKey(env)).rejects.toThrow(
      /LITELLM_MASTER_KEY not found/,
    );
  });
});

describe("provisionResourceSyncKey", () => {
  it("issues a key limited to access-group routes and verifies its scope", async () => {
    answers["/key/generate"] = [{ status: 200, body: { key: "sk-res" } }];
    expect(await provisionResourceSyncKey(env)).toBe("created");
    expect(readFileSync(env.resourceSyncKeyFile, "utf8")).toBe("sk-res\n");
    const gen = calls.find((c) => c.path === "/key/generate")!;
    expect(gen.body).toEqual({
      user_id: "auth-service-resource-sync",
      key_alias: RESOURCE_SYNC_KEY_ALIAS,
      allowed_routes: RESOURCE_SYNC_ROUTES,
    });
    expect(calls.map((c) => c.path)).toEqual([
      "/user/new",
      "/key/delete",
      "/key/generate",
      "/v1/access_group",
      "/team/list",
      "/model/info",
    ]);
    expect(
      RESOURCE_SYNC_ROUTES.every((r) => r.startsWith("/v1/access_group")),
    ).toBe(true);
  });

  it("keeps a resource-sync key whose scope probes still match", async () => {
    answers["/key/generate"] = [{ status: 200, body: { key: "sk-res" } }];
    await provisionResourceSyncKey(env);
    calls.length = 0;
    expect(await provisionResourceSyncKey(env)).toBe("kept");
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/access_group",
      "/team/list",
      "/model/info",
    ]);
  });

  it("refuses a key that can still reach team administration", async () => {
    answers["/key/generate"] = [{ status: 200, body: { key: "sk-wide" } }];
    answers["/team/list"] = [{ status: 200, body: [] }];
    await expect(provisionResourceSyncKey(env)).rejects.toThrow(
      /does not enforce its access-group scope/,
    );
    expect(calls.at(-1)).toMatchObject({
      path: "/key/delete",
      body: { key_aliases: [RESOURCE_SYNC_KEY_ALIAS] },
    });
  });
});

describe("provisionKeys", () => {
  it("issues both keys into separate files", async () => {
    answers["/key/generate"] = [
      { status: 200, body: { key: "sk-team" } },
      { status: 200, body: { key: "sk-res" } },
    ];
    expect(await provisionKeys(env)).toEqual({
      team: "created",
      resourceSync: "created",
    });
    expect(readFileSync(env.keyFile, "utf8")).toBe("sk-team\n");
    expect(readFileSync(env.resourceSyncKeyFile, "utf8")).toBe("sk-res\n");
  });
});

describe("loadProvisionEnv", () => {
  it("requires every variable and trims the trailing slash", () => {
    expect(() => loadProvisionEnv({})).toThrow(/LITELLM_URL/);
    expect(
      loadProvisionEnv({
        LITELLM_URL: "http://litellm:4000/",
        LITELLM_PROVISIONER_KEY_FILE: "/k/key",
        LITELLM_STATE_FILE: "/s",
      }).gatewayUrl,
    ).toBe("http://litellm:4000");
  });

  it("defaults the resource-sync key next to the team key", () => {
    expect(
      loadProvisionEnv({
        LITELLM_URL: "http://litellm:4000",
        LITELLM_PROVISIONER_KEY_FILE: "/run/keys/key",
        LITELLM_STATE_FILE: "/s",
      }).resourceSyncKeyFile,
    ).toBe("/run/keys/resource-sync-key");
  });
});
