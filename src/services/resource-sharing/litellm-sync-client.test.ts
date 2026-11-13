import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => {
  const state = {
    config: {
      features: { resourceSharing: true },
      litellm: {
        url: "http://gw:4000",
        resourceSyncKeyFile: "",
      },
    },
  };
  return { state };
});

vi.mock("../../config.js", () => ({ config: state.config }));

import { resourceSyncMethodAllowed } from "./litellm-scope.js";
import {
  LitellmResourceSyncError,
  assertResourceSyncReady,
  isResourceSyncActive,
  listAccessGroups,
  updateAccessGroupMembers,
} from "./litellm-sync-client.js";

const GROUP = {
  access_group_id: "group-1",
  access_group_name: "owner:free",
  access_model_names: ["owner/model-a"],
  access_mcp_server_ids: ["mcp-1"],
  access_agent_ids: ["agent-1"],
};

let calls: Array<{ method: string; url: string; body: unknown; auth: string }>;
let answers: Array<{ status: number; body: unknown }>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "res-sync-"));
  state.config.features.resourceSharing = true;
  state.config.litellm.url = "http://gw:4000";
  state.config.litellm.resourceSyncKeyFile = join(dir, "key");
  writeFileSync(state.config.litellm.resourceSyncKeyFile, "sk-sync\n");
  calls = [];
  answers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        method: init.method ?? "GET",
        url,
        body: init.body ? JSON.parse(init.body as string) : undefined,
        auth: new Headers(init.headers).get("Authorization") ?? "",
      });
      const answer = answers.shift();
      if (!answer) throw new Error("unexpected fetch");
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resource-sync route and method allowlist", () => {
  it("allows only list and update", () => {
    expect(resourceSyncMethodAllowed("GET", "/v1/access_group")).toBe(true);
    expect(resourceSyncMethodAllowed("PUT", "/v1/access_group/group-1")).toBe(
      true,
    );
    expect(resourceSyncMethodAllowed("POST", "/v1/access_group")).toBe(false);
    expect(
      resourceSyncMethodAllowed("DELETE", "/v1/access_group/group-1"),
    ).toBe(false);
    expect(resourceSyncMethodAllowed("GET", "/team/list")).toBe(false);
    expect(resourceSyncMethodAllowed("PUT", "/model/update")).toBe(false);
    expect(resourceSyncMethodAllowed("GET", "/v1/access_group/group-1")).toBe(
      false,
    );
  });

  it("refuses an update with an empty id before calling the gateway", async () => {
    await expect(
      updateAccessGroupMembers("", { access_model_names: [] }),
    ).rejects.toBeInstanceOf(LitellmResourceSyncError);
    expect(calls).toEqual([]);
  });
});

describe("credential readiness", () => {
  it("is inactive when the feature or the gateway is off", () => {
    state.config.features.resourceSharing = false;
    expect(isResourceSyncActive()).toBe(false);
    expect(() => assertResourceSyncReady()).not.toThrow();
    state.config.features.resourceSharing = true;
    state.config.litellm.url = "";
    expect(isResourceSyncActive()).toBe(false);
    expect(() => assertResourceSyncReady()).not.toThrow();
  });

  it("fails loud when active without the sync key", () => {
    state.config.litellm.resourceSyncKeyFile = "/does/not/exist";
    expect(() => assertResourceSyncReady()).toThrow(
      /resource-sync gateway key is unavailable/,
    );
  });
});

describe("listAccessGroups", () => {
  it("accepts the bare array shape and sends the dedicated bearer", async () => {
    answers.push({ status: 200, body: [GROUP] });
    const groups = await listAccessGroups();
    expect(groups).toEqual([
      {
        id: "group-1",
        name: "owner:free",
        modelNames: ["owner/model-a"],
        mcpServerIds: ["mcp-1"],
        agentIds: ["agent-1"],
      },
    ]);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "http://gw:4000/v1/access_group",
      auth: "Bearer sk-sync",
    });
  });

  it("accepts the wrapped legacy shape", async () => {
    answers.push({ status: 200, body: { access_groups: [GROUP] } });
    expect((await listAccessGroups())[0]?.name).toBe("owner:free");
  });

  it("fails permanently on an invalid payload without retrying", async () => {
    answers.push({ status: 200, body: { nope: true } });
    await expect(listAccessGroups()).rejects.toMatchObject({
      transient: false,
      message: "gateway returned an invalid access-group list",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("updateAccessGroupMembers", () => {
  it("PUTs only the supplied membership fields", async () => {
    answers.push({ status: 200, body: GROUP });
    await updateAccessGroupMembers("group-1", {
      access_model_names: ["owner/model-a"],
      access_agent_ids: [],
    });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: "http://gw:4000/v1/access_group/group-1",
      body: {
        access_model_names: ["owner/model-a"],
        access_agent_ids: [],
      },
    });
  });

  it("retries a transient 503 and succeeds on the next attempt", async () => {
    answers.push({ status: 503, body: {} });
    answers.push({ status: 200, body: GROUP });
    await expect(
      updateAccessGroupMembers("group-1", { access_mcp_server_ids: ["mcp-1"] }),
    ).resolves.toMatchObject({ id: "group-1" });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a permanent 4xx", async () => {
    answers.push({ status: 403, body: {} });
    await expect(
      updateAccessGroupMembers("group-1", { access_agent_ids: ["agent-1"] }),
    ).rejects.toMatchObject({
      transient: false,
      message: "gateway PUT /v1/access_group/group-1 failed: HTTP 403",
    });
    expect(calls).toHaveLength(1);
  });

  it("gives up after the bounded retries on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(
      updateAccessGroupMembers("group-1", { access_agent_ids: [] }),
    ).rejects.toMatchObject({
      transient: true,
      message: "gateway unreachable while syncing shared resources",
    });
  });
});
