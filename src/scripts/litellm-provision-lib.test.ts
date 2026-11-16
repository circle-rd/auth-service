import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INVENTORY_KEY_ALIAS,
  INVENTORY_ROUTES,
  loadProvisionEnv,
  provisionInventoryKey,
  provisionKeys,
  type ProvisionEnv,
} from "./litellm-provision-lib.js";

let env: ProvisionEnv;
let calls: Array<{
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}>;
let answers: Record<string, Array<{ status: number; body: unknown }>>;

function answer(
  method: string,
  path: string,
): { status: number; body: unknown } {
  const queue = answers[`${method} ${path}`];
  if (!queue || queue.length === 0) return { status: 403, body: {} };
  return queue.length > 1 ? queue.shift()! : queue[0]!;
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  env = {
    gatewayUrl: "http://gw:4000",
    inventoryKeyFile: join(dir, "sub", "inventory-key"),
    stateFile: join(dir, "secrets.env"),
  };
  writeFileSync(env.stateFile, "A=1\nLITELLM_MASTER_KEY=sk-master\n");
  calls = [];
  answers = {
    "POST /user/new": [{ status: 200, body: {} }],
    "POST /key/delete": [{ status: 200, body: {} }],
    "POST /key/generate": [
      { status: 200, body: { key: "sk-inventory" } },
      { status: 403, body: {} },
    ],
    "GET /v1/models": [{ status: 200, body: { data: [] } }],
    "GET /v1/agents": [{ status: 200, body: [] }],
    "GET /v1/mcp/server": [{ status: 200, body: [] }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("http://gw:4000", "");
      const method = init.method ?? "GET";
      calls.push({
        method,
        path,
        body: init.body ? JSON.parse(init.body as string) : undefined,
        auth: new Headers(init.headers).get("Authorization"),
      });
      const a = answer(method, path);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provisionInventoryKey", () => {
  it("creates a read-only viewer key limited to inventory routes", async () => {
    expect(await provisionInventoryKey(env)).toBe("created");
    expect(readFileSync(env.inventoryKeyFile, "utf8")).toBe("sk-inventory\n");
    const gen = calls.find((c) => c.path === "/key/generate")!;
    expect(gen.auth).toBe("Bearer sk-master");
    expect(gen.body).toEqual({
      user_id: "auth-service-inventory",
      key_alias: INVENTORY_KEY_ALIAS,
      allowed_routes: INVENTORY_ROUTES,
    });
    expect(calls.find((c) => c.path === "/user/new")!.body).toMatchObject({
      user_role: "proxy_admin_viewer",
    });
    expect(INVENTORY_ROUTES).toEqual([
      "/v1/models",
      "/v1/agents",
      "/v1/mcp/server",
    ]);
  });

  it("keeps a key whose read probes pass and write probes are refused", async () => {
    await provisionInventoryKey(env);
    calls.length = 0;
    answers["POST /key/generate"] = [{ status: 403, body: {} }];
    expect(await provisionInventoryKey(env)).toBe("kept");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/models",
      "GET /v1/agents",
      "GET /v1/mcp/server",
      "POST /v1/mcp/server",
      "POST /team/new",
      "POST /key/generate",
    ]);
  });

  it("replaces a key that no longer works, revoking the old one first", async () => {
    await provisionInventoryKey(env);
    calls.length = 0;
    answers["GET /v1/models"] = [
      { status: 401, body: {} },
      { status: 200, body: { data: [] } },
    ];
    answers["POST /key/generate"] = [
      { status: 200, body: { key: "sk-newer" } },
      { status: 403, body: {} },
    ];
    expect(await provisionInventoryKey(env)).toBe("created");
    expect(calls.map((c) => c.path)).toContain("/key/delete");
    expect(readFileSync(env.inventoryKeyFile, "utf8")).toBe("sk-newer\n");
  });

  it("refuses a key that can still write inventory", async () => {
    answers["POST /key/generate"] = [
      { status: 200, body: { key: "sk-wide" } },
      { status: 403, body: {} },
    ];
    answers["POST /v1/mcp/server"] = [{ status: 200, body: [] }];
    await expect(provisionInventoryKey(env)).rejects.toThrow(
      /does not enforce its read-only inventory scope/,
    );
    expect(calls.at(-1)).toMatchObject({
      path: "/key/delete",
      body: { key_aliases: [INVENTORY_KEY_ALIAS] },
    });
  });

  it("accepts an owner that already exists, refuses other failures", async () => {
    answers["POST /user/new"] = [
      { status: 400, body: { error: "User already exists" } },
    ];
    expect(await provisionInventoryKey(env)).toBe("created");
    rmSync(env.inventoryKeyFile);
    answers["POST /user/new"] = [{ status: 500, body: { error: "boom" } }];
    await expect(provisionInventoryKey(env)).rejects.toThrow(
      /user creation failed/,
    );
  });

  it("fails loud without the master key", async () => {
    writeFileSync(env.stateFile, "A=1\n");
    await expect(provisionInventoryKey(env)).rejects.toThrow(
      /LITELLM_MASTER_KEY not found/,
    );
  });
});

describe("provisionKeys", () => {
  it("issues the inventory key", async () => {
    expect(await provisionKeys(env)).toEqual({ inventory: "created" });
    expect(readFileSync(env.inventoryKeyFile, "utf8")).toBe("sk-inventory\n");
  });
});

describe("loadProvisionEnv", () => {
  it("requires every variable and trims the trailing slash", () => {
    expect(() => loadProvisionEnv({})).toThrow(/LITELLM_URL/);
    expect(
      loadProvisionEnv({
        LITELLM_URL: "http://litellm:4000/",
        LITELLM_INVENTORY_KEY_FILE: "/k/inventory",
        LITELLM_STATE_FILE: "/s",
      }).gatewayUrl,
    ).toBe("http://litellm:4000");
  });

  it("keeps the configured inventory key path", () => {
    expect(
      loadProvisionEnv({
        LITELLM_URL: "http://litellm:4000",
        LITELLM_INVENTORY_KEY_FILE: "/run/keys/inventory",
        LITELLM_STATE_FILE: "/s",
      }).inventoryKeyFile,
    ).toBe("/run/keys/inventory");
  });
});
