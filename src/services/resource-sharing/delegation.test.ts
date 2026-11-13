import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";

const { mockDb, state } = vi.hoisted(() => {
  const state = { results: [] as unknown[][] };
  const terminal = () => Promise.resolve(state.results.shift() ?? []);
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => terminal(),
  };
  return {
    state,
    mockDb: { select: () => chain },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

const { assertAppDelegation, hasDelegatedPermission, isApplicationOwner } =
  await import("./delegation.js");

const APP = "app-a-id";
const USER = "user-a";

beforeEach(() => {
  state.results = [];
});

describe("application owner authority", () => {
  it("treats the application admin role as the initial owner", async () => {
    state.results = [[{ roleId: "role-admin" }]];
    await expect(isApplicationOwner(USER, APP)).resolves.toBe(true);
    state.results = [[{ roleId: "role-admin" }]];
    await expect(assertAppDelegation(USER, APP, "grants:manage")).resolves.toBe(
      undefined,
    );
  });

  it("falls back to an active explicit delegation", async () => {
    state.results = [[{ id: "delegation-1" }]];
    await expect(
      hasDelegatedPermission(USER, APP, "resources:manage"),
    ).resolves.toBe(true);
    state.results = [[], [{ id: "delegation-1" }]];
    await expect(
      assertAppDelegation(USER, APP, "resources:manage"),
    ).resolves.toBeUndefined();
  });

  it("grants resources:read to a resources:manage delegation", async () => {
    state.results = [[{ id: "delegation-1" }]];
    await expect(
      hasDelegatedPermission(USER, APP, "resources:read"),
    ).resolves.toBe(true);
  });

  it("answers foreign or missing applications with the same 404", async () => {
    state.results = [[], []];
    const error = await assertAppDelegation(USER, APP, "grants:manage").then(
      () => {
        throw new Error("expected rejection");
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(404);
    expect((error as ApiError).code).toBe("RES_004");
  });

  it("does not consult platform roles", async () => {
    state.results = [[], []];
    await expect(
      assertAppDelegation("platform-admin", APP, "resources:read"),
    ).rejects.toMatchObject({ code: "RES_004" });
  });
});
