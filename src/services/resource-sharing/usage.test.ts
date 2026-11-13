import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";

const { state, mockDb, mockLatestGrant } = vi.hoisted(() => {
  const state = {
    results: [] as unknown[][],
    lastValues: undefined as unknown,
  };
  const terminal = () => Promise.resolve(state.results.shift() ?? []);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => terminal(),
    returning: () => terminal(),
    onConflictDoNothing: () => chain,
    values: (values: unknown) => {
      state.lastValues = values;
      return chain;
    },
    then: (
      resolve: (rows: unknown[]) => unknown,
      reject: (error: unknown) => unknown,
    ) => terminal().then(resolve, reject),
  };
  return {
    state,
    mockLatestGrant: vi.fn(),
    mockDb: {
      select: () => chain,
      insert: () => chain,
    },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("./grants.js", () => ({ findLatestGrant: mockLatestGrant }));

const { getOwnerUsage, recordUsageEvent } = await import("./usage.js");

const RESOURCE = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const PLAN = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-13T12:00:00.000Z");

const input = (overrides: Record<string, unknown> = {}) => ({
  subjectId: "subject-a",
  clientId: "client-a",
  resourceId: RESOURCE,
  resourceType: "model" as const,
  resourceKey: "app-a/model-a",
  planName: "Team",
  requestId: "a".repeat(64),
  occurredAt: NOW,
  usageSource: "provider" as const,
  costUsd: "0.010000000000000000",
  promptTokens: 6,
  completionTokens: 4,
  totalTokens: 10,
  ...overrides,
});

const stored = (overrides: Record<string, unknown> = {}) => ({
  id: "usage-1",
  subjectId: "subject-a",
  clientId: "client-a",
  ownerApplicationId: OWNER,
  resourceId: RESOURCE,
  resourceType: "model",
  resourceKey: "app-a/model-a",
  planId: PLAN,
  requestId: "a".repeat(64),
  promptTokens: 6,
  completionTokens: 4,
  totalTokens: 10,
  costUsd: "0.010000000000000000",
  usageSource: "provider",
  occurredAt: NOW,
  createdAt: NOW,
  ...overrides,
});

const resourceRow = {
  id: RESOURCE,
  ownerApplicationId: OWNER,
  resourceType: "model",
  key: "app-a/model-a",
};

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: "grant-1",
  subjectId: "subject-a",
  ownerApplicationId: OWNER,
  resourceId: RESOURCE,
  planId: PLAN,
  allowedClientIds: null,
  expiresAt: null,
  revokedAt: null,
  createdBy: "owner",
  createdAt: NOW,
  planName: "Team",
  ...overrides,
});

function rejection(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      return error as ApiError;
    },
  );
}

beforeEach(() => {
  state.results = [];
  state.lastValues = undefined;
  mockLatestGrant.mockReset().mockResolvedValue(grant());
});

describe("recordUsageEvent", () => {
  function prepareSuccess() {
    state.results = [
      [resourceRow],
      [{ id: PLAN }],
      [{ id: "membership-1" }],
      [stored()],
    ];
  }

  it("derives owner and plan and inserts the gross event", async () => {
    prepareSuccess();
    const result = await recordUsageEvent(input());
    expect(result.replayed).toBe(false);
    expect(state.lastValues).toMatchObject({
      subjectId: "subject-a",
      clientId: "client-a",
      ownerApplicationId: OWNER,
      resourceId: RESOURCE,
      planId: PLAN,
      usageSource: "provider",
      costUsd: "0.010000000000000000",
    });
  });

  it("derives the plan for an explicit grant and checks its client", async () => {
    state.results = [[resourceRow], [{ id: PLAN }], [], [stored()]];
    mockLatestGrant.mockResolvedValue(
      grant({ allowedClientIds: ["client-a"] }),
    );
    await recordUsageEvent(input());
    expect(mockLatestGrant).toHaveBeenCalledWith("subject-a", OWNER, RESOURCE);
  });

  it("replays an equal event and rejects a conflicting payload", async () => {
    prepareSuccess();
    // The insert returns no row, then the lookup finds the stored one.
    state.results = [
      [resourceRow],
      [{ id: PLAN }],
      [{ id: "membership-1" }],
      [],
      [stored({ costUsd: "0.010000000000000000" })],
    ];
    const replay = await recordUsageEvent(input({ costUsd: "0.0100" }));
    expect(replay.replayed).toBe(true);

    state.results = [
      [resourceRow],
      [{ id: PLAN }],
      [{ id: "membership-1" }],
      [],
      [stored()],
    ];
    const conflict = await rejection(
      recordUsageEvent(input({ costUsd: "0.02" })),
    );
    expect(conflict.code).toBe("RES_012");
  });

  it("rejects a missing insert result without an existing row", async () => {
    state.results = [[resourceRow], [{ id: PLAN }], [{ id: "m" }], [], []];
    const error = await rejection(recordUsageEvent(input()));
    expect(error.code).toBe("RES_012");
  });

  it.each([
    ["unknown resource", [[]]],
    [
      "mismatched type",
      [[{ ...resourceRow, resourceType: "workflow" }], [{ id: PLAN }]],
    ],
    [
      "mismatched key",
      [[{ ...resourceRow, key: "app-a/other" }], [{ id: PLAN }]],
    ],
    ["unknown plan", [[resourceRow], []]],
  ])("rejects %s", async (_label, results) => {
    state.results = results as unknown[][];
    const error = await rejection(recordUsageEvent(input()));
    expect(error.code).toBe("RES_011");
  });

  it("rejects a subject with no relation to the owner", async () => {
    state.results = [[resourceRow], [{ id: PLAN }], []];
    mockLatestGrant.mockResolvedValue(null);
    const error = await rejection(recordUsageEvent(input()));
    expect(error.code).toBe("RES_011");
  });

  it("rejects a plan that does not match the explicit grant", async () => {
    state.results = [[resourceRow], [{ id: PLAN }], []];
    mockLatestGrant.mockResolvedValue(grant({ planName: "Other" }));
    const error = await rejection(recordUsageEvent(input()));
    expect(error.code).toBe("RES_011");
  });

  it("rejects a client outside the explicit grant", async () => {
    state.results = [[resourceRow], [{ id: PLAN }], []];
    mockLatestGrant.mockResolvedValue(
      grant({ allowedClientIds: ["client-b"] }),
    );
    const error = await rejection(recordUsageEvent(input()));
    expect(error.code).toBe("RES_011");
  });
});

describe("getOwnerUsage", () => {
  const query = {
    ownerApplicationId: OWNER,
    groupBy: "user" as const,
    from: new Date("2026-11-01T00:00:00.000Z"),
    to: new Date("2026-12-01T00:00:00.000Z"),
    limit: 2,
    offset: 0,
  };

  it("aggregates by subject with totals and pagination", async () => {
    state.results = [
      [
        {
          calls: 3,
          unsupportedCalls: "1",
          tokenlessCalls: "1",
          promptTokens: "15",
          completionTokens: "15",
          totalTokens: "30",
          costUsd: "0.60",
        },
      ],
      [
        {
          subjectId: "subject-a",
          calls: 2,
          unsupportedCalls: "0",
          tokenlessCalls: "0",
          promptTokens: "10",
          completionTokens: "10",
          totalTokens: "20",
          costUsd: "0.30",
        },
        {
          subjectId: "subject-b",
          calls: 1,
          unsupportedCalls: "0",
          tokenlessCalls: "0",
          promptTokens: "5",
          completionTokens: "5",
          totalTokens: "10",
          costUsd: "0.30",
        },
        {
          subjectId: "subject-c",
          calls: 1,
          unsupportedCalls: "0",
          tokenlessCalls: "0",
          promptTokens: "5",
          completionTokens: "5",
          totalTokens: "10",
          costUsd: "0.10",
        },
      ],
    ];
    const result = await getOwnerUsage(query);
    expect(result.groupBy).toBe("user");
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(2);
    expect(result.totals).toEqual({
      calls: 3,
      unsupportedCalls: 1,
      tokenlessCalls: 1,
      promptTokens: 15,
      completionTokens: 15,
      totalTokens: 30,
      costUsd: "0.60",
    });
  });

  it("aggregates by resource and returns an empty total when nothing matched", async () => {
    state.results = [
      [],
      [
        {
          resourceId: RESOURCE,
          resourceType: "model",
          resourceKey: "app-a/model-a",
          displayName: "Model A",
          calls: 1,
          unsupportedCalls: "0",
          tokenlessCalls: "0",
          promptTokens: "6",
          completionTokens: "4",
          totalTokens: "10",
          costUsd: "0.01",
        },
      ],
    ];
    const result = await getOwnerUsage({ ...query, groupBy: "resource" });
    expect(result.groupBy).toBe("resource");
    expect(result.items).toHaveLength(1);
    expect(result.totals).toEqual({
      calls: 0,
      unsupportedCalls: 0,
      tokenlessCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: "0",
    });
  });
});
