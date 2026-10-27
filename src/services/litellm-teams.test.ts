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
  deleteAccessGroupByName,
  deleteTeam,
  ensureAccessGroup,
  ensurePlanTeam,
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
      const body =
        next.status === 204 || next.json === null
          ? null
          : JSON.stringify(next.json);
      return new Response(body, { status: next.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const groupList = (groups: Array<{ id: string; name: string }>) => ({
  status: 200,
  json: {
    access_groups: groups.map((g) => ({
      access_group_id: g.id,
      access_group_name: g.name,
    })),
  },
});

describe("ensureAccessGroup", () => {
  it("creates an empty group when it is missing", async () => {
    responses = [
      groupList([]),
      {
        status: 201,
        json: { access_group_id: "g1", access_group_name: "app:free" },
      },
    ];
    expect(await ensureAccessGroup("app:free")).toBe("g1");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/access_group",
      "POST /v1/access_group",
    ]);
    expect(calls[1]!.body).toEqual({
      access_group_name: "app:free",
      description: "Managed by auth-service for the plan 'app:free'.",
    });
    expect(calls[0]!.auth).toBe("Bearer sk-prov");
  });

  it("reuses an existing group", async () => {
    responses = [groupList([{ id: "g9", name: "app:free" }])];
    expect(await ensureAccessGroup("app:free")).toBe("g9");
    expect(calls.map((c) => c.path)).toEqual(["/v1/access_group"]);
  });
});

describe("deleteAccessGroupByName", () => {
  it("deletes a group by name and ignores a missing one", async () => {
    responses = [
      groupList([{ id: "g1", name: "app:free" }]),
      { status: 204, json: null },
    ];
    await deleteAccessGroupByName("app:free");
    responses = [groupList([])];
    await deleteAccessGroupByName("app:premium");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/access_group",
      "DELETE /v1/access_group/g1",
      "GET /v1/access_group",
    ]);
  });
});

describe("ensurePlanTeam", () => {
  it("creates a closed team carrying the plan's access group", async () => {
    responses = [
      groupList([]),
      {
        status: 201,
        json: { access_group_id: "g1", access_group_name: "my-app:free" },
      },
      { status: 404, json: { detail: "not found" } },
      { status: 200, json: {} },
    ];
    await ensurePlanTeam("my-app:free", "My App - Free", "my-app:free");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/access_group",
      "POST /v1/access_group",
      "GET /team/info?team_id=my-app%3Afree",
      "POST /team/new",
    ]);
    expect(calls[3]!.body).toEqual({
      team_id: "my-app:free",
      team_alias: "My App - Free",
      models: ["no-default-models"],
      access_group_ids: ["g1"],
      metadata: { managed_by: "auth-service" },
    });
  });

  it("treats a 'Team not found' error as missing", async () => {
    responses = [
      groupList([{ id: "g1", name: "x" }]),
      {
        status: 500,
        json: { detail: { error: "Team not found, passed team_id=x" } },
      },
      { status: 200, json: {} },
    ];
    await ensurePlanTeam("x", "X", "x");
    expect(calls.at(-1)!.path).toBe("/team/new");
  });

  it("adopts an existing team and attaches the plan's group", async () => {
    responses = [
      groupList([{ id: "g1", name: "a" }]),
      {
        status: 200,
        json: { team_info: { team_id: "a", metadata: { note: 1 } } },
      },
      { status: 200, json: {} },
      { status: 200, json: {} },
    ];
    await ensurePlanTeam("a", "A", "a");
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/access_group",
      "/team/info?team_id=a",
      "/team/update",
      "/team/update",
    ]);
    expect(calls[2]!.body).toEqual({
      team_id: "a",
      metadata: { note: 1, managed_by: "auth-service" },
    });
    expect(calls[3]!.body).toEqual({
      team_id: "a",
      access_group_ids: ["g1"],
    });
    expect(calls.some((c) => c.path === "/team/new")).toBe(false);
  });

  it("does nothing for a managed team already carrying its group", async () => {
    responses = [
      groupList([{ id: "g1", name: "a" }]),
      {
        status: 200,
        json: {
          team_info: {
            team_id: "a",
            access_group_ids: ["g1"],
            metadata: { managed_by: "auth-service" },
          },
        },
      },
    ];
    await ensurePlanTeam("a", "A", "a");
    expect(calls).toHaveLength(2);
  });

  it("unblocks a team auth-service blocked, but not one an admin blocked", async () => {
    responses = [
      groupList([{ id: "g1", name: "a" }]),
      {
        status: 200,
        json: {
          team_info: {
            team_id: "a",
            blocked: true,
            access_group_ids: ["g1"],
            metadata: {
              managed_by: "auth-service",
              blocked_by_auth_service: true,
            },
          },
        },
      },
      { status: 200, json: {} },
      { status: 200, json: {} },
    ];
    await ensurePlanTeam("a", "A", "a");
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/access_group",
      "/team/info?team_id=a",
      "/team/unblock",
      "/team/update",
    ]);

    calls.length = 0;
    responses = [
      groupList([{ id: "g1", name: "b" }]),
      {
        status: 200,
        json: {
          team_info: {
            team_id: "b",
            blocked: true,
            access_group_ids: ["g1"],
            metadata: { managed_by: "auth-service" },
          },
        },
      },
    ];
    await ensurePlanTeam("b", "B", "b");
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/access_group",
      "/team/info?team_id=b",
    ]);
  });

  it("fails loud when the gateway refuses", async () => {
    responses = [
      groupList([]),
      { status: 201, json: { access_group_id: "g1", access_group_name: "a" } },
      { status: 404, json: { detail: "not found" } },
      { status: 403, json: { error: "denied" } },
    ];
    await expect(ensurePlanTeam("a", "A", "a")).rejects.toThrow(
      /team creation failed: HTTP 403/,
    );
  });

  it("fails loud when the key has not been delivered", async () => {
    rmSync(keyFile);
    await expect(ensurePlanTeam("a", "A", "a")).rejects.toBeInstanceOf(
      LitellmGatewayError,
    );
  });

  it("reports an unreachable gateway", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    await expect(ensurePlanTeam("a", "A", "a")).rejects.toThrow(/unreachable/);
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
