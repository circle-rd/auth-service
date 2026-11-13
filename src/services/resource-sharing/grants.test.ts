import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";

const { mockDb, state } = vi.hoisted(() => {
  const state = {
    results: [] as unknown[][],
    lastValues: undefined as unknown,
  };
  const terminal = () => Promise.resolve(state.results.shift() ?? []);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    orderBy: () => chain,
    limit: () => terminal(),
    returning: () => terminal(),
    values: (values: unknown) => {
      state.lastValues = values;
      return chain;
    },
    set: (values: unknown) => {
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
    mockDb: {
      select: () => chain,
      insert: () => chain,
      update: () => chain,
    },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

const {
  createResourceGrant,
  findLatestGrant,
  getGrantForOwner,
  hasActiveMembership,
  listGrantsForOwner,
  revokeResourceGrant,
  updateResourceGrant,
} = await import("./grants.js");

const OWNER = "owner-app";
const PLAN = "plan-1";
const NOW = new Date("2026-11-13T12:00:00Z");

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: "grant-1",
  subjectId: "subject-a",
  ownerApplicationId: OWNER,
  resourceId: null,
  planId: PLAN,
  allowedClientIds: null,
  expiresAt: null,
  revokedAt: null,
  createdBy: "owner",
  createdAt: NOW,
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
});

describe("createResourceGrant", () => {
  it("creates a whole-application grant", async () => {
    state.results = [[{ id: OWNER }], [{ id: PLAN }], [], [grant()]];
    const created = await createResourceGrant({
      subjectId: "subject-a",
      ownerApplicationId: OWNER,
      planId: PLAN,
      createdBy: "owner",
    });
    expect(created.id).toBe("grant-1");
    expect(state.lastValues).toMatchObject({
      subjectId: "subject-a",
      ownerApplicationId: OWNER,
      resourceId: null,
      planId: PLAN,
      allowedClientIds: null,
    });
  });

  it("creates a resource-specific grant with a deduplicated client allow-list", async () => {
    state.results = [
      [{ id: OWNER }],
      [{ id: PLAN }],
      [{ id: "resource-1" }],
      [],
      [grant({ resourceId: "resource-1" })],
    ];
    await createResourceGrant({
      subjectId: "subject-a",
      ownerApplicationId: OWNER,
      resourceId: "resource-1",
      planId: PLAN,
      allowedClientIds: ["client-a", "client-a", "client-b"],
      createdBy: "owner",
    });
    expect(state.lastValues).toMatchObject({
      resourceId: "resource-1",
      allowedClientIds: ["client-a", "client-b"],
    });
  });

  it("rejects an unknown owner application", async () => {
    state.results = [[]];
    const error = await rejection(
      createResourceGrant({
        subjectId: "subject-a",
        ownerApplicationId: OWNER,
        planId: PLAN,
        createdBy: "owner",
      }),
    );
    expect(error.code).toBe("APP_002");
  });

  it("rejects a plan of another application", async () => {
    state.results = [[{ id: OWNER }], []];
    const error = await rejection(
      createResourceGrant({
        subjectId: "subject-a",
        ownerApplicationId: OWNER,
        planId: PLAN,
        createdBy: "owner",
      }),
    );
    expect(error.code).toBe("RES_001");
  });

  it("rejects a resource of another application", async () => {
    state.results = [[{ id: OWNER }], [{ id: PLAN }], []];
    const error = await rejection(
      createResourceGrant({
        subjectId: "subject-a",
        ownerApplicationId: OWNER,
        resourceId: "resource-1",
        planId: PLAN,
        createdBy: "owner",
      }),
    );
    expect(error.code).toBe("RES_002");
  });

  it("rejects an empty client allow-list", async () => {
    state.results = [[{ id: OWNER }], [{ id: PLAN }]];
    const error = await rejection(
      createResourceGrant({
        subjectId: "subject-a",
        ownerApplicationId: OWNER,
        planId: PLAN,
        allowedClientIds: [],
        createdBy: "owner",
      }),
    );
    expect(error.code).toBe("RES_001");
  });

  it("rejects a second active grant for the same subject", async () => {
    state.results = [[{ id: OWNER }], [{ id: PLAN }], [{ id: "grant-1" }]];
    const error = await rejection(
      createResourceGrant({
        subjectId: "subject-a",
        ownerApplicationId: OWNER,
        planId: PLAN,
        createdBy: "owner",
      }),
    );
    expect(error.code).toBe("RES_008");
  });

  it("rejects an empty insert result", async () => {
    state.results = [[{ id: OWNER }], [{ id: PLAN }], [], []];
    const error = await rejection(
      createResourceGrant({
        subjectId: "subject-a",
        ownerApplicationId: OWNER,
        planId: PLAN,
        createdBy: "owner",
      }),
    );
    expect(error.code).toBe("RES_001");
  });
});

describe("revokeResourceGrant", () => {
  it("sets revoked_at on an active grant", async () => {
    state.results = [[grant()], [grant({ revokedAt: NOW })]];
    const revoked = await revokeResourceGrant("grant-1", NOW);
    expect(revoked.revokedAt).toEqual(NOW);
    expect(state.lastValues).toEqual({ revokedAt: NOW });
  });

  it("is idempotent for an already revoked grant", async () => {
    state.results = [[grant({ revokedAt: NOW })]];
    const revoked = await revokeResourceGrant("grant-1", new Date());
    expect(revoked.revokedAt).toEqual(NOW);
  });

  it("answers RES_007 when the grant is unknown", async () => {
    state.results = [[]];
    const error = await rejection(revokeResourceGrant("grant-1"));
    expect(error.code).toBe("RES_007");
  });
});

describe("findLatestGrant", () => {
  it("returns null when there is no grant", async () => {
    state.results = [[]];
    expect(await findLatestGrant("subject-a", OWNER, "resource-1")).toBeNull();
  });

  it("returns the latest grant with its plan name", async () => {
    state.results = [[{ ...grant(), planName: "Team" }]];
    expect(
      await findLatestGrant("subject-a", OWNER, "resource-1"),
    ).toMatchObject({ planName: "Team" });
  });
});

describe("hasActiveMembership", () => {
  it("is true for an active membership row", async () => {
    state.results = [[{ id: "membership-1" }]];
    expect(await hasActiveMembership("subject-a", OWNER)).toBe(true);
  });

  it("is false without a row", async () => {
    state.results = [[]];
    expect(await hasActiveMembership("subject-a", OWNER)).toBe(false);
  });
});

describe("owner grant administration", () => {
  it("scopes a grant lookup to the owner application", async () => {
    state.results = [[grant()]];
    await expect(getGrantForOwner("grant-1", OWNER)).resolves.toMatchObject({
      id: "grant-1",
      ownerApplicationId: OWNER,
    });
  });

  it("answers RES_007 when the grant belongs to another owner", async () => {
    state.results = [[]];
    const error = await rejection(getGrantForOwner("grant-1", OWNER));
    expect(error.code).toBe("RES_007");
  });

  it("lists grants with plan names", async () => {
    state.results = [[{ ...grant(), planName: "Team" }]];
    await expect(listGrantsForOwner(OWNER)).resolves.toEqual([
      expect.objectContaining({ id: "grant-1", planName: "Team" }),
    ]);
  });

  it("validates a replacement resource and plan against the owner", async () => {
    state.results = [
      [grant()],
      [{ id: PLAN }],
      [{ id: "resource-1" }],
      [grant({ resourceId: "resource-1" })],
    ];
    const updated = await updateResourceGrant("grant-1", OWNER, {
      planId: PLAN,
      resourceId: "resource-1",
      allowedClientIds: ["client-a", "client-a"],
      expiresAt: NOW,
    });
    expect(updated.resourceId).toBe("resource-1");
    expect(state.lastValues).toMatchObject({
      planId: PLAN,
      resourceId: "resource-1",
      allowedClientIds: ["client-a"],
      expiresAt: NOW,
    });
  });

  it("clears narrowing and expiry", async () => {
    state.results = [
      [grant({ resourceId: "resource-1", expiresAt: NOW })],
      [grant()],
    ];
    await updateResourceGrant("grant-1", OWNER, {
      resourceId: null,
      allowedClientIds: null,
      expiresAt: null,
    });
    expect(state.lastValues).toMatchObject({
      resourceId: null,
      allowedClientIds: null,
      expiresAt: null,
    });
  });

  it("rejects updates to a revoked grant", async () => {
    state.results = [[grant({ revokedAt: NOW })]];
    const error = await rejection(
      updateResourceGrant("grant-1", OWNER, { planId: PLAN }),
    );
    expect(error.code).toBe("RES_001");
  });

  it("rejects an empty client allow-list", async () => {
    state.results = [[grant()]];
    const error = await rejection(
      updateResourceGrant("grant-1", OWNER, { allowedClientIds: [] }),
    );
    expect(error.code).toBe("RES_001");
  });
});
