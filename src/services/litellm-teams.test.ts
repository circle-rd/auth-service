import { rmSync, writeFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { dir, keyFile } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "teams-"));
  return { dir: d, keyFile: path.join(d, "key") };
});

vi.mock("../config.js", () => ({
  config: { litellm: { url: "http://gw:4000", provisionerKeyFile: keyFile } },
}));

import {
  LitellmGatewayError,
  blockTeam,
  deleteTeam,
  ensureTeam,
  listTeams,
} from "./litellm-teams.js";

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

let calls: Call[];
let responses: Array<{ status: number; json: unknown }>;

beforeEach(() => {
  writeFileSync(keyFile, "sk-prov\n");
  calls = [];
  responses = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        method: init.method ?? "GET",
        path: url.replace("http://gw:4000", ""),
        body: init.body ? JSON.parse(init.body as string) : undefined,
        auth: new Headers(init.headers).get("Authorization"),
      });
      const next = responses.shift() ?? { status: 200, json: {} };
      return new Response(JSON.stringify(next.json), { status: next.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureTeam", () => {
  it("creates a closed team, marked as managed, when it is missing", async () => {
    responses = [{ status: 404, json: { detail: "not found" } }];
    await ensureTeam("my-app", "My App");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /team/info?team_id=my-app",
      "POST /team/new",
    ]);
    expect(calls[1]!.body).toEqual({
      team_id: "my-app",
      team_alias: "My App",
      models: ["no-default-models"],
      metadata: { managed_by: "auth-service" },
    });
    expect(calls[0]!.auth).toBe("Bearer sk-prov");
  });

  it("treats a 'Team not found' error as missing", async () => {
    responses = [
      {
        status: 500,
        json: { detail: { error: "Team not found, passed team_id=x" } },
      },
    ];
    await ensureTeam("x", "X");
    expect(calls[1]!.path).toBe("/team/new");
  });

  it("adopts an existing team without touching its configuration", async () => {
    responses = [
      {
        status: 200,
        json: { team_info: { team_id: "a", metadata: { note: 1 } } },
      },
    ];
    await ensureTeam("a", "A");
    expect(calls[1]!.path).toBe("/team/update");
    expect(calls[1]!.body).toEqual({
      team_id: "a",
      metadata: { note: 1, managed_by: "auth-service" },
    });
    expect(calls.some((c) => c.path === "/team/new")).toBe(false);
  });

  it("does nothing for a team already managed and usable", async () => {
    responses = [
      {
        status: 200,
        json: {
          team_info: { team_id: "a", metadata: { managed_by: "auth-service" } },
        },
      },
    ];
    await ensureTeam("a", "A");
    expect(calls).toHaveLength(1);
  });

  it("unblocks a team auth-service blocked, but not one an admin blocked", async () => {
    responses = [
      {
        status: 200,
        json: {
          team_info: {
            team_id: "a",
            blocked: true,
            metadata: {
              managed_by: "auth-service",
              blocked_by_auth_service: true,
            },
          },
        },
      },
    ];
    await ensureTeam("a", "A");
    expect(calls.map((c) => c.path)).toEqual([
      "/team/info?team_id=a",
      "/team/unblock",
      "/team/update",
    ]);

    calls.length = 0;
    responses = [
      {
        status: 200,
        json: {
          team_info: {
            team_id: "b",
            blocked: true,
            metadata: { managed_by: "auth-service" },
          },
        },
      },
    ];
    await ensureTeam("b", "B");
    expect(calls.map((c) => c.path)).toEqual(["/team/info?team_id=b"]);
  });

  it("fails loud when the gateway refuses", async () => {
    responses = [
      { status: 404, json: { detail: "not found" } },
      { status: 403, json: { error: "denied" } },
    ];
    await expect(ensureTeam("a", "A")).rejects.toThrow(
      /team creation failed: HTTP 403/,
    );
  });

  it("fails loud when the key has not been delivered", async () => {
    rmSync(keyFile);
    await expect(ensureTeam("a", "A")).rejects.toBeInstanceOf(
      LitellmGatewayError,
    );
  });

  it("reports an unreachable gateway", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    await expect(ensureTeam("a", "A")).rejects.toThrow(/unreachable/);
  });
});

describe("blockTeam", () => {
  it("remembers that auth-service blocked the team, then blocks it", async () => {
    responses = [
      {
        status: 200,
        json: {
          team_info: { team_id: "a", metadata: { managed_by: "auth-service" } },
        },
      },
    ];
    await blockTeam("a");
    expect(calls.map((c) => c.path)).toEqual([
      "/team/info?team_id=a",
      "/team/update",
      "/team/block",
    ]);
    expect(calls[1]!.body).toEqual({
      team_id: "a",
      metadata: { managed_by: "auth-service", blocked_by_auth_service: true },
    });
  });

  it("ignores a missing or already blocked team", async () => {
    responses = [{ status: 404, json: {} }];
    await blockTeam("gone");
    responses = [
      { status: 200, json: { team_info: { team_id: "a", blocked: true } } },
    ];
    await blockTeam("a");
    expect(calls.map((c) => c.path)).toEqual([
      "/team/info?team_id=gone",
      "/team/info?team_id=a",
    ]);
  });
});

describe("deleteTeam", () => {
  it("deletes an existing team and ignores a missing one", async () => {
    responses = [{ status: 200, json: { team_info: { team_id: "a" } } }];
    await deleteTeam("a");
    responses = [{ status: 404, json: {} }];
    await deleteTeam("b");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /team/info?team_id=a",
      "POST /team/delete",
      "GET /team/info?team_id=b",
    ]);
    expect(calls[1]!.body).toEqual({ team_ids: ["a"] });
  });
});

describe("listTeams", () => {
  it("accepts a bare array and a wrapped one", async () => {
    responses = [{ status: 200, json: [{ team_id: "a" }] }];
    expect((await listTeams()).map((t) => t.team_id)).toEqual(["a"]);
    responses = [{ status: 200, json: { teams: [{ team_id: "b" }] } }];
    expect((await listTeams()).map((t) => t.team_id)).toEqual(["b"]);
  });
});
