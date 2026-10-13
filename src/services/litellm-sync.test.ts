import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rows: [] as unknown[][],
  configured: true,
  ensureTeam: vi.fn(async (_s: string, _n: string): Promise<void> => undefined),
  blockTeam: vi.fn(async (_s: string): Promise<void> => undefined),
  deleteTeam: vi.fn(async (_s: string): Promise<void> => undefined),
  listTeams: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("../config.js", () => ({ config: { litellm: {} } }));
vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../db/index.js", () => {
  const chain = () => {
    const rows = m.rows.shift() ?? [];
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = () => c;
    c.limit = () => Promise.resolve(rows);
    c.then = (resolve: (v: unknown) => unknown) => resolve(rows);
    return c;
  };
  return { db: { select: () => chain() } };
});
vi.mock("./litellm-teams.js", () => {
  class LitellmGatewayError extends Error {}
  return {
    LitellmGatewayError,
    isGatewayConfigured: () => m.configured,
    ensureTeam: m.ensureTeam,
    blockTeam: m.blockTeam,
    deleteTeam: m.deleteTeam,
    listTeams: m.listTeams,
  };
});

import { LitellmGatewayError } from "./litellm-teams.js";
import {
  ensureTeamBeforeSave,
  reconcileLitellmTeams,
  retireTeamAfterSave,
  supportsLitellm,
} from "./litellm-sync.js";

const GW = "https://llm.example.com";

beforeEach(() => {
  m.rows = [];
  m.configured = true;
  vi.clearAllMocks();
});

describe("supportsLitellm", () => {
  it("needs the gateway URL among the allowed resources", () => {
    expect(supportsLitellm([GW, "https://x"], GW)).toBe(true);
    expect(supportsLitellm(["https://x"], GW)).toBe(false);
    expect(supportsLitellm([GW], null)).toBe(false);
  });
});

describe("ensureTeamBeforeSave", () => {
  const app = { slug: "app", name: "App", allowedResources: [GW] };

  it("creates the team when the support is newly enabled", async () => {
    m.rows = [[{ url: GW }]];
    await ensureTeamBeforeSave(app, []);
    expect(m.ensureTeam).toHaveBeenCalledWith("app", "App");
  });

  it("does nothing when the support was already there, is absent, or no gateway is deployed", async () => {
    m.rows = [[{ url: GW }]];
    await ensureTeamBeforeSave(app, [GW]);
    m.rows = [[{ url: GW }]];
    await ensureTeamBeforeSave({ ...app, allowedResources: [] }, []);
    m.rows = [[]];
    await ensureTeamBeforeSave(app, []);
    m.configured = false;
    await ensureTeamBeforeSave(app, []);
    expect(m.ensureTeam).not.toHaveBeenCalled();
  });

  it("refuses the save with SRV_004 when the gateway cannot create the team", async () => {
    m.rows = [[{ url: GW }]];
    m.ensureTeam.mockRejectedValueOnce(new LitellmGatewayError("down"));
    await expect(ensureTeamBeforeSave(app, [])).rejects.toMatchObject({
      code: "SRV_004",
      statusCode: 502,
    });
  });
});

describe("retireTeamAfterSave", () => {
  it("blocks the team of an edited application that lost the support", async () => {
    m.rows = [[{ url: GW }]];
    await retireTeamAfterSave("app", [GW], []);
    expect(m.blockTeam).toHaveBeenCalledWith("app");
  });

  it("deletes the team of a deleted application that had the support", async () => {
    m.rows = [[{ url: GW }]];
    await retireTeamAfterSave("app", [GW], null);
    expect(m.deleteTeam).toHaveBeenCalledWith("app");
  });

  it("leaves alone an application that keeps or never had the support", async () => {
    m.rows = [[{ url: GW }]];
    await retireTeamAfterSave("app", [GW], [GW]);
    m.rows = [[{ url: GW }]];
    await retireTeamAfterSave("app", [], null);
    expect(m.blockTeam).not.toHaveBeenCalled();
    expect(m.deleteTeam).not.toHaveBeenCalled();
  });

  it("never throws: the reconciler retries", async () => {
    m.rows = [[{ url: GW }]];
    m.blockTeam.mockRejectedValueOnce(new Error("down"));
    await expect(retireTeamAfterSave("app", [GW], [])).resolves.toBeUndefined();
  });
});

describe("reconcileLitellmTeams", () => {
  it("ensures supporting apps and blocks managed teams that lost theirs", async () => {
    m.rows = [
      [{ url: GW }],
      [
        { slug: "on", name: "On", allowedResources: [GW], isSystem: false },
        { slug: "off", name: "Off", allowedResources: [], isSystem: false },
        {
          slug: "litellm",
          name: "LiteLLM",
          allowedResources: [GW],
          isSystem: true,
        },
      ],
    ];
    m.listTeams.mockResolvedValueOnce([
      { team_id: "on", metadata: { managed_by: "auth-service" } },
      { team_id: "off", metadata: { managed_by: "auth-service" } },
      { team_id: "gone", metadata: { managed_by: "auth-service" } },
      { team_id: "hand-made" },
      {
        team_id: "already",
        blocked: true,
        metadata: { managed_by: "auth-service" },
      },
    ]);
    const report = await reconcileLitellmTeams();
    expect(report).toEqual({
      ensured: ["on"],
      blocked: ["off", "gone"],
      failed: [],
    });
    expect(m.blockTeam.mock.calls.map((c) => c[0])).toEqual(["off", "gone"]);
  });

  it("reports failures without stopping", async () => {
    m.rows = [
      [{ url: GW }],
      [
        { slug: "a", name: "A", allowedResources: [GW], isSystem: false },
        { slug: "b", name: "B", allowedResources: [GW], isSystem: false },
      ],
    ];
    m.ensureTeam.mockRejectedValueOnce(new Error("boom"));
    const report = await reconcileLitellmTeams();
    expect(report.failed).toEqual(["a"]);
    expect(report.ensured).toEqual(["b"]);
  });

  it("is a no-op without a deployed gateway", async () => {
    m.rows = [[]];
    expect(await reconcileLitellmTeams()).toEqual({
      ensured: [],
      blocked: [],
      failed: [],
    });
    expect(m.listTeams).not.toHaveBeenCalled();
  });
});
