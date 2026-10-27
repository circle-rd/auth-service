import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rows: [] as unknown[][],
  configured: true,
  ensurePlanTeam: vi.fn(
    async (_t: string, _a: string, _g: string): Promise<void> => undefined,
  ),
  blockTeam: vi.fn(async (_t: string): Promise<void> => undefined),
  deleteTeam: vi.fn(async (_t: string): Promise<void> => undefined),
  deleteAccessGroupByName: vi.fn(
    async (_n: string): Promise<void> => undefined,
  ),
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
    MANAGED_BY: "auth-service",
    isGatewayConfigured: () => m.configured,
    ensurePlanTeam: m.ensurePlanTeam,
    blockTeam: m.blockTeam,
    deleteTeam: m.deleteTeam,
    deleteAccessGroupByName: m.deleteAccessGroupByName,
    listTeams: m.listTeams,
  };
});

import { LitellmGatewayError } from "./litellm-teams.js";
import {
  ensurePlanTeamBeforeSave,
  ensureTeamBeforeSave,
  reconcileLitellmTeams,
  retirePlanTeam,
  retireRenamedPlanTeam,
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

  it("creates the team of every plan when the support is newly enabled", async () => {
    m.rows = [[{ url: GW }]];
    await ensureTeamBeforeSave(app, [], ["free", "premium"]);
    expect(m.ensurePlanTeam.mock.calls.map((c) => c[0])).toEqual([
      "app:free",
      "app:premium",
    ]);
    expect(m.ensurePlanTeam.mock.calls[0]).toEqual([
      "app:free",
      "App - free",
      "app:free",
    ]);
  });

  it("looks the plans up when they are not passed", async () => {
    m.rows = [[{ url: GW }], [{ id: "app-1" }], [{ name: "free" }]];
    await ensureTeamBeforeSave(app, []);
    expect(m.ensurePlanTeam).toHaveBeenCalledWith(
      "app:free",
      "App - free",
      "app:free",
    );
  });

  it("does nothing when the support was already there, is absent, or no gateway is deployed", async () => {
    m.rows = [[{ url: GW }]];
    await ensureTeamBeforeSave(app, [GW], ["free"]);
    m.rows = [[{ url: GW }]];
    await ensureTeamBeforeSave({ ...app, allowedResources: [] }, [], ["free"]);
    m.rows = [[]];
    await ensureTeamBeforeSave(app, [], ["free"]);
    m.configured = false;
    await ensureTeamBeforeSave(app, [], ["free"]);
    expect(m.ensurePlanTeam).not.toHaveBeenCalled();
  });

  it("refuses the save with SRV_004 when the gateway cannot create the team", async () => {
    m.rows = [[{ url: GW }]];
    m.ensurePlanTeam.mockRejectedValueOnce(new LitellmGatewayError("down"));
    await expect(ensureTeamBeforeSave(app, [], ["free"])).rejects.toMatchObject(
      {
        code: "SRV_004",
        statusCode: 502,
      },
    );
  });
});

describe("retireTeamAfterSave", () => {
  it("blocks every managed team of an edited application that lost the support", async () => {
    m.rows = [[{ url: GW }]];
    m.listTeams.mockResolvedValueOnce([
      { team_id: "app:free", metadata: { managed_by: "auth-service" } },
      { team_id: "app:premium", metadata: { managed_by: "auth-service" } },
      { team_id: "other:free", metadata: { managed_by: "auth-service" } },
    ]);
    await retireTeamAfterSave("app", [GW], []);
    expect(m.blockTeam.mock.calls.map((c) => c[0])).toEqual([
      "app:free",
      "app:premium",
    ]);
  });

  it("deletes the managed teams and groups of a deleted application, never an admin-made one", async () => {
    m.rows = [[{ url: GW }]];
    m.listTeams.mockResolvedValueOnce([
      { team_id: "app:free", metadata: { managed_by: "auth-service" } },
      { team_id: "app:hand-made", metadata: { note: 1 } },
    ]);
    await retireTeamAfterSave("app", [GW], null);
    expect(m.deleteTeam.mock.calls.map((c) => c[0])).toEqual(["app:free"]);
    expect(m.deleteAccessGroupByName.mock.calls.map((c) => c[0])).toEqual([
      "app:free",
    ]);
  });

  it("leaves alone an application that keeps or never had the support", async () => {
    m.rows = [[{ url: GW }]];
    await retireTeamAfterSave("app", [GW], [GW]);
    m.rows = [[{ url: GW }]];
    await retireTeamAfterSave("app", [], null);
    expect(m.blockTeam).not.toHaveBeenCalled();
    expect(m.deleteTeam).not.toHaveBeenCalled();
    expect(m.listTeams).not.toHaveBeenCalled();
  });

  it("never throws: the reconciler retries", async () => {
    m.rows = [[{ url: GW }]];
    m.listTeams.mockRejectedValueOnce(new Error("down"));
    await expect(retireTeamAfterSave("app", [GW], [])).resolves.toBeUndefined();
  });
});

describe("ensurePlanTeamBeforeSave", () => {
  it("ensures the plan's team when the application has the support", async () => {
    m.rows = [
      [{ url: GW }],
      [
        {
          id: "app-1",
          slug: "app",
          name: "App",
          allowedResources: [GW],
          isSystem: false,
        },
      ],
    ];
    await ensurePlanTeamBeforeSave("app-1", "premium");
    expect(m.ensurePlanTeam).toHaveBeenCalledWith(
      "app:premium",
      "App - premium",
      "app:premium",
    );
  });

  it("does nothing for a system application or one without support", async () => {
    m.rows = [
      [{ url: GW }],
      [
        {
          id: "litellm",
          slug: "litellm",
          name: "LiteLLM",
          allowedResources: [GW],
          isSystem: true,
        },
      ],
    ];
    await ensurePlanTeamBeforeSave("litellm", "free");
    expect(m.ensurePlanTeam).not.toHaveBeenCalled();
  });
});

describe("retirePlanTeam", () => {
  const appRow = {
    id: "app-1",
    slug: "app",
    name: "App",
    allowedResources: [GW],
    isSystem: false,
  };

  it("blocks the plan's team and drops its group", async () => {
    m.rows = [[{ url: GW }], [appRow]];
    await retirePlanTeam("app-1", "free");
    expect(m.blockTeam).toHaveBeenCalledWith("app:free");
    expect(m.deleteAccessGroupByName).toHaveBeenCalledWith("app:free");
  });

  it("retires the previous team when a rename changes the slug", async () => {
    m.rows = [[appRow], [{ url: GW }], [appRow]];
    await retireRenamedPlanTeam("app-1", "Basic", "Premium");
    expect(m.blockTeam).toHaveBeenCalledWith("app:basic");
    expect(m.deleteAccessGroupByName).toHaveBeenCalledWith("app:basic");
  });

  it("retires nothing when the new name maps to the same team", async () => {
    m.rows = [[appRow]];
    await retireRenamedPlanTeam("app-1", "Free", "free");
    expect(m.blockTeam).not.toHaveBeenCalled();
    expect(m.deleteAccessGroupByName).not.toHaveBeenCalled();
  });
});

describe("reconcileLitellmTeams", () => {
  it("ensures supporting plan teams and blocks managed teams that lost theirs", async () => {
    m.rows = [
      [{ url: GW }],
      [
        {
          id: "1",
          slug: "on",
          name: "On",
          allowedResources: [GW],
          isSystem: false,
        },
        {
          id: "2",
          slug: "off",
          name: "Off",
          allowedResources: [],
          isSystem: false,
        },
        {
          id: "3",
          slug: "litellm",
          name: "LiteLLM",
          allowedResources: [GW],
          isSystem: true,
        },
      ],
      [{ name: "free" }],
    ];
    m.listTeams.mockResolvedValueOnce([
      { team_id: "on:free", metadata: { managed_by: "auth-service" } },
      { team_id: "off:free", metadata: { managed_by: "auth-service" } },
      { team_id: "gone:free", metadata: { managed_by: "auth-service" } },
      { team_id: "hand-made" },
      {
        team_id: "already:free",
        blocked: true,
        metadata: { managed_by: "auth-service" },
      },
    ]);
    const report = await reconcileLitellmTeams();
    expect(report).toEqual({
      ensured: ["on:free"],
      blocked: ["off:free", "gone:free"],
      failed: [],
    });
    expect(m.blockTeam.mock.calls.map((c) => c[0])).toEqual([
      "off:free",
      "gone:free",
    ]);
  });

  it("reports failures without stopping", async () => {
    m.rows = [
      [{ url: GW }],
      [
        {
          id: "1",
          slug: "a",
          name: "A",
          allowedResources: [GW],
          isSystem: false,
        },
        {
          id: "2",
          slug: "b",
          name: "B",
          allowedResources: [GW],
          isSystem: false,
        },
      ],
      [{ name: "free" }],
      [{ name: "free" }],
    ];
    m.ensurePlanTeam.mockRejectedValueOnce(new Error("boom"));
    const report = await reconcileLitellmTeams();
    expect(report.failed).toEqual(["a:free"]);
    expect(report.ensured).toEqual(["b:free"]);
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
