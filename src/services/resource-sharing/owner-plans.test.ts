import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, state } = vi.hoisted(() => {
  const state = { results: [] as unknown[][], where: undefined as unknown };
  const terminal = () => Promise.resolve(state.results.shift() ?? []);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (condition: unknown) => {
      state.where = condition;
      return chain;
    },
    orderBy: () => terminal(),
  };
  return { state, mockDb: { select: () => chain } };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

const { listOwnerPlans } = await import("./owner-plans.js");

beforeEach(() => {
  state.results = [];
  state.where = undefined;
});

describe("listOwnerPlans", () => {
  it("returns the owner application's plans", async () => {
    state.results = [
      [{ id: "plan-a", name: "Team", description: null, isDefault: true }],
    ];
    await expect(listOwnerPlans("app-a")).resolves.toEqual([
      { id: "plan-a", name: "Team", description: null, isDefault: true },
    ]);
    expect(state.where).toBeDefined();
  });

  it("returns an empty list when the application has no plans", async () => {
    state.results = [[]];
    await expect(listOwnerPlans("app-a")).resolves.toEqual([]);
  });
});
