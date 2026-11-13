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
    orderBy: () => terminal(),
    limit: () => terminal(),
    returning: () => terminal(),
    onConflictDoNothing: () => chain,
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
  createSharedResource,
  findResourceByKey,
  getSharedResource,
  listPublishedResourcesByType,
  listSharedResources,
  updateSharedResource,
} = await import("./registry.js");

const OWNER = "owner-app";
const PLAN = "plan-1";

const resource = (overrides: Record<string, unknown> = {}) => ({
  id: "resource-1",
  ownerApplicationId: OWNER,
  resourceType: "model",
  key: "app-a/model-a",
  displayName: "Model A",
  upstreamRef: null,
  status: "draft",
  visibility: "invited_only",
  defaultPlanId: null,
  createdAt: new Date("2026-11-13T12:00:00Z"),
  updatedAt: new Date("2026-11-13T12:00:00Z"),
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

describe("createSharedResource", () => {
  it("derives the canonical key from the owner slug and inserts a draft", async () => {
    state.results = [[{ slug: "app-a" }], [resource()]];
    const created = await createSharedResource({
      ownerApplicationId: OWNER,
      resourceType: "model",
      slug: "model-a",
      displayName: "Model A",
    });
    expect(created.key).toBe("app-a/model-a");
    expect(state.lastValues).toMatchObject({
      ownerApplicationId: OWNER,
      key: "app-a/model-a",
      status: "draft",
      visibility: "invited_only",
    });
  });

  it("keeps the requested status and visibility", async () => {
    state.results = [
      [{ slug: "app-a" }],
      [resource({ status: "published", visibility: "public_catalog" })],
    ];
    await createSharedResource({
      ownerApplicationId: OWNER,
      resourceType: "model",
      slug: "model-a",
      displayName: "Model A",
      status: "published",
      visibility: "public_catalog",
    });
    expect(state.lastValues).toMatchObject({
      status: "published",
      visibility: "public_catalog",
    });
  });

  it("accepts a plan that belongs to the owner", async () => {
    state.results = [[{ slug: "app-a" }], [{ id: PLAN }], [resource()]];
    await createSharedResource({
      ownerApplicationId: OWNER,
      resourceType: "model",
      slug: "model-a",
      displayName: "Model A",
      defaultPlanId: PLAN,
    });
    expect(state.lastValues).toMatchObject({ defaultPlanId: PLAN });
  });

  it("rejects a plan of another application", async () => {
    state.results = [[{ slug: "app-a" }], []];
    const error = await rejection(
      createSharedResource({
        ownerApplicationId: OWNER,
        resourceType: "model",
        slug: "model-a",
        displayName: "Model A",
        defaultPlanId: PLAN,
      }),
    );
    expect(error.code).toBe("RES_001");
  });

  it("rejects an unknown owner application", async () => {
    state.results = [[]];
    const error = await rejection(
      createSharedResource({
        ownerApplicationId: OWNER,
        resourceType: "model",
        slug: "model-a",
        displayName: "Model A",
      }),
    );
    expect(error.code).toBe("APP_002");
  });

  it("rejects an invalid slug", async () => {
    state.results = [[{ slug: "app-a" }]];
    const error = await rejection(
      createSharedResource({
        ownerApplicationId: OWNER,
        resourceType: "model",
        slug: "Model A",
        displayName: "Model A",
      }),
    );
    expect(error.code).toBe("RES_005");
  });

  it("rejects an invalid status", async () => {
    state.results = [[{ slug: "app-a" }]];
    const error = await rejection(
      createSharedResource({
        ownerApplicationId: OWNER,
        resourceType: "model",
        slug: "model-a",
        displayName: "Model A",
        status: "secret" as never,
      }),
    );
    expect(error.code).toBe("RES_001");
  });

  it("rejects an invalid visibility", async () => {
    state.results = [[{ slug: "app-a" }]];
    const error = await rejection(
      createSharedResource({
        ownerApplicationId: OWNER,
        resourceType: "model",
        slug: "model-a",
        displayName: "Model A",
        visibility: "everyone" as never,
      }),
    );
    expect(error.code).toBe("RES_001");
  });

  it("rejects a duplicate key", async () => {
    state.results = [[{ slug: "app-a" }], []];
    const error = await rejection(
      createSharedResource({
        ownerApplicationId: OWNER,
        resourceType: "model",
        slug: "model-a",
        displayName: "Model A",
      }),
    );
    expect(error.code).toBe("RES_003");
  });
});

describe("getSharedResource", () => {
  it("returns the row", async () => {
    state.results = [[resource()]];
    expect(await getSharedResource("resource-1")).toMatchObject({
      id: "resource-1",
    });
  });

  it("answers RES_002 when missing", async () => {
    state.results = [[]];
    const error = await rejection(getSharedResource("resource-1"));
    expect(error.code).toBe("RES_002");
  });
});

describe("listSharedResources", () => {
  it("lists the owner's resources", async () => {
    state.results = [[resource(), resource({ id: "resource-2" })]];
    expect(await listSharedResources(OWNER)).toHaveLength(2);
  });
});

describe("findResourceByKey", () => {
  it("returns null when the key is unknown", async () => {
    state.results = [[]];
    expect(await findResourceByKey("app-a/model-a")).toBeNull();
  });

  it("returns the row with the owner slug", async () => {
    state.results = [[{ ...resource(), ownerApplicationSlug: "app-a" }]];
    expect(await findResourceByKey("app-a/model-a")).toMatchObject({
      ownerApplicationSlug: "app-a",
    });
  });

  it("rejects a malformed key before querying", async () => {
    const error = await rejection(findResourceByKey("app-a/model-a/extra"));
    expect(error.code).toBe("RES_005");
  });
});

describe("listPublishedResourcesByType", () => {
  it("returns the candidate rows", async () => {
    state.results = [[{ ...resource(), status: "published" }]];
    expect(await listPublishedResourcesByType("model")).toHaveLength(1);
  });
});

describe("updateSharedResource", () => {
  it("renames a draft key", async () => {
    state.results = [
      [resource()],
      [{ slug: "app-a" }],
      [],
      [resource({ key: "app-a/model-b" })],
    ];
    const updated = await updateSharedResource("resource-1", {
      slug: "model-b",
      displayName: "Model B",
    });
    expect(updated.key).toBe("app-a/model-b");
    expect(state.lastValues).toMatchObject({
      key: "app-a/model-b",
      displayName: "Model B",
    });
  });

  it("refuses to change a key once published", async () => {
    state.results = [[resource({ status: "published" })]];
    const error = await rejection(
      updateSharedResource("resource-1", { slug: "model-b" }),
    );
    expect(error.code).toBe("RES_006");
  });

  it("refuses a key that another resource already holds", async () => {
    state.results = [[resource()], [{ slug: "app-a" }], [{ id: "resource-2" }]];
    const error = await rejection(
      updateSharedResource("resource-1", { slug: "model-b" }),
    );
    expect(error.code).toBe("RES_003");
  });

  it("updates status and visibility", async () => {
    state.results = [
      [resource()],
      [{ slug: "app-a" }],
      [resource({ status: "published" })],
    ];
    await updateSharedResource("resource-1", {
      status: "published",
      visibility: "public_catalog",
    });
    expect(state.lastValues).toMatchObject({
      status: "published",
      visibility: "public_catalog",
    });
  });

  it("rejects an invalid status", async () => {
    state.results = [[resource()], [{ slug: "app-a" }]];
    const error = await rejection(
      updateSharedResource("resource-1", { status: "secret" as never }),
    );
    expect(error.code).toBe("RES_001");
  });

  it("rejects a plan of another application", async () => {
    state.results = [[resource()], [{ slug: "app-a" }], []];
    const error = await rejection(
      updateSharedResource("resource-1", { defaultPlanId: PLAN }),
    );
    expect(error.code).toBe("RES_001");
  });

  it("clears an upstream reference with an explicit null", async () => {
    state.results = [
      [resource({ upstreamRef: "ref" })],
      [{ slug: "app-a" }],
      [resource({ upstreamRef: null })],
    ];
    await updateSharedResource("resource-1", { upstreamRef: null });
    expect(state.lastValues).toMatchObject({ upstreamRef: null });
  });

  it("refuses to change the upstream reference once published", async () => {
    state.results = [
      [resource({ upstreamRef: "old", status: "published" })],
      [{ slug: "app-a" }],
    ];
    const error = await rejection(
      updateSharedResource("resource-1", { upstreamRef: "new" }),
    );
    expect(error.code).toBe("RES_009");
  });

  it("allows changing the upstream reference while still a draft", async () => {
    state.results = [
      [resource({ upstreamRef: "old" })],
      [{ slug: "app-a" }],
      [resource({ upstreamRef: "new" })],
    ];
    await updateSharedResource("resource-1", { upstreamRef: "new" });
    expect(state.lastValues).toMatchObject({ upstreamRef: "new" });
  });

  it("rejects a missing resource", async () => {
    state.results = [[]];
    const error = await rejection(updateSharedResource("ghost", {}));
    expect(error.code).toBe("RES_002");
  });
});
