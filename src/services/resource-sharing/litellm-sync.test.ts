import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  class LitellmResourceSyncError extends Error {
    constructor(
      message: string,
      public readonly transient: boolean,
    ) {
      super(message);
    }
  }
  return {
    LitellmResourceSyncError,
    results: [] as unknown[][],
    selects: 0,
    active: true,
    gateway: "https://gw.example.test" as string | null,
    groups: [] as Array<Record<string, unknown>>,
    listAccessGroups: vi.fn(async (): Promise<unknown[]> => []),
    updateAccessGroupMembers: vi.fn(
      async (_id: string, _patch: unknown): Promise<unknown> => ({}),
    ),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
});

vi.mock("../../db/index.js", () => {
  const chain = () => {
    const rows = m.results.shift() ?? [];
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.innerJoin = () => c;
    c.where = () => c;
    c.then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
    return c;
  };
  return {
    db: {
      select: () => {
        m.selects += 1;
        return chain();
      },
    },
  };
});
vi.mock("../../logger.js", () => ({ logger: m.logger }));
vi.mock("../litellm-sync.js", () => ({
  gatewayUrl: async (): Promise<string | null> => m.gateway,
}));
vi.mock("./litellm-sync-client.js", () => ({
  LitellmResourceSyncError: m.LitellmResourceSyncError,
  assertResourceSyncReady: () => undefined,
  isResourceSyncActive: () => m.active,
  listAccessGroups: m.listAccessGroups,
  updateAccessGroupMembers: m.updateAccessGroupMembers,
}));

import {
  reconcileSharedResources,
  queueOwnerResourceSync,
  startResourceSync,
} from "./litellm-sync.js";

const GW = "https://gw.example.test";
const OWNER = "owner-app";

const resource = (overrides: Record<string, unknown> = {}) => ({
  resourceId: "resource-1",
  ownerApplicationId: OWNER,
  ownerSlug: "app-a",
  allowedResources: [GW],
  resourceType: "model",
  key: "app-a/model-a",
  upstreamRef: null,
  status: "published",
  ...overrides,
});

const group = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: `id-${name}`,
  name,
  modelNames: [],
  mcpServerIds: [],
  agentIds: [],
  ...overrides,
});

const plans = [
  { applicationId: OWNER, name: "free" },
  { applicationId: OWNER, name: "premium" },
];

beforeEach(() => {
  m.results = [];
  m.selects = 0;
  m.active = true;
  m.gateway = GW;
  m.groups = [];
  vi.clearAllMocks();
  m.listAccessGroups.mockImplementation(async () => m.groups);
  m.updateAccessGroupMembers.mockImplementation(async () => ({}));
});

describe("reconcileSharedResources", () => {
  it("adds a published model to every owner plan group, keeping operator entries", async () => {
    m.results = [[resource()], plans];
    m.groups = [
      group("app-a:free", { modelNames: ["operator/model"] }),
      group("app-a:premium"),
    ];

    const report = await reconcileSharedResources();

    expect(report).toMatchObject({ updated: 2, unchanged: 0, failed: 0 });
    expect(m.updateAccessGroupMembers.mock.calls).toEqual([
      [
        "id-app-a:free",
        { access_model_names: ["operator/model", "app-a/model-a"] },
      ],
      ["id-app-a:premium", { access_model_names: ["app-a/model-a"] }],
    ]);
  });

  it("maps workflow and MCP resources to the opaque ids in upstream_ref", async () => {
    m.results = [
      [
        resource({
          resourceId: "wf",
          resourceType: "workflow",
          key: "app-a/wf-a",
          upstreamRef: "agent-id-1",
        }),
        resource({
          resourceId: "mcp",
          resourceType: "mcp_agent",
          key: "app-a/mcp-a",
          upstreamRef: "server-id-1",
        }),
      ],
      [plans[0]],
    ];
    m.groups = [group("app-a:free")];

    await reconcileSharedResources();

    expect(m.updateAccessGroupMembers).toHaveBeenCalledWith("id-app-a:free", {
      access_agent_ids: ["agent-id-1"],
      access_mcp_server_ids: ["server-id-1"],
    });
  });

  it("leaves https endpoints and unsupported owners untouched", async () => {
    m.results = [
      [
        resource({ resourceType: "https_endpoint" }),
        resource({
          resourceId: "other",
          ownerApplicationId: "other-app",
          ownerSlug: "other-app",
          allowedResources: [],
        }),
      ],
      plans,
    ];
    m.groups = [group("app-a:free"), group("app-a:premium")];

    const report = await reconcileSharedResources();

    expect(report.updated).toBe(0);
    expect(m.updateAccessGroupMembers).not.toHaveBeenCalled();
  });

  it("removes a disabled resource while preserving operator entries", async () => {
    m.results = [[resource({ status: "disabled" })], [plans[0]]];
    m.groups = [
      group("app-a:free", {
        modelNames: ["operator/model", "app-a/model-a"],
      }),
    ];

    await reconcileSharedResources();

    expect(m.updateAccessGroupMembers).toHaveBeenCalledWith("id-app-a:free", {
      access_model_names: ["operator/model"],
    });
  });

  it("leaves an operator entry alone when the matching resource is still a draft", async () => {
    m.results = [[resource({ status: "draft" })], [plans[0]]];
    m.groups = [group("app-a:free", { modelNames: ["app-a/model-a"] })];

    const report = await reconcileSharedResources();

    expect(report.unchanged).toBe(1);
    expect(m.updateAccessGroupMembers).not.toHaveBeenCalled();
  });

  it("never touches a group that is not the owner plan group", async () => {
    m.results = [[resource()], [plans[0]]];
    m.groups = [group("other-app:free"), group("manual-group")];

    const report = await reconcileSharedResources();

    expect(report.skippedGroups).toBe(1);
    expect(m.updateAccessGroupMembers).not.toHaveBeenCalled();
  });

  it("fails loud for a published agent without upstream_ref", async () => {
    m.results = [
      [resource({ resourceType: "workflow", key: "app-a/wf-a" })],
      [plans[0]],
    ];
    m.groups = [group("app-a:free")];

    const report = await reconcileSharedResources();

    expect(report.failed).toBe(1);
    expect(m.updateAccessGroupMembers).not.toHaveBeenCalled();
    expect(m.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "missing_upstream_ref" }),
      "[res] published resource cannot be synced to LiteLLM",
    );
  });

  it("reports a transient update failure and continues with the next plan", async () => {
    m.results = [[resource()], plans];
    m.groups = [group("app-a:free"), group("app-a:premium")];
    m.updateAccessGroupMembers.mockRejectedValueOnce(
      new m.LitellmResourceSyncError("gateway PUT failed", true),
    );

    const report = await reconcileSharedResources();

    expect(report).toMatchObject({ updated: 1, failed: 1 });
    expect(m.logger.warn).toHaveBeenCalled();
  });

  it("returns a failed report when the gateway cannot be listed", async () => {
    m.results = [[resource()], plans];
    m.listAccessGroups.mockRejectedValueOnce(
      new m.LitellmResourceSyncError("gateway unreachable", true),
    );

    const report = await reconcileSharedResources();

    expect(report.failed).toBe(1);
    expect(m.updateAccessGroupMembers).not.toHaveBeenCalled();
  });

  it("does nothing when sync is inactive or no gateway is deployed", async () => {
    m.active = false;
    expect(await reconcileSharedResources()).toMatchObject({ updated: 0 });
    expect(m.results).toHaveLength(0);

    m.active = true;
    m.gateway = null;
    m.results = [[resource()]];
    expect(await reconcileSharedResources()).toMatchObject({ updated: 0 });
  });
});

describe("lifecycle entry points", () => {
  it("queues an owner-scoped reconcile only when active", async () => {
    m.results = [[resource()], [plans[0]]];
    m.groups = [];
    queueOwnerResourceSync(OWNER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(m.selects).toBe(2);

    m.selects = 0;
    m.active = false;
    queueOwnerResourceSync(OWNER);
    expect(m.selects).toBe(0);
  });

  it("starts no interval when inactive", () => {
    m.active = false;
    expect(() => startResourceSync()).not.toThrow();
  });
});
