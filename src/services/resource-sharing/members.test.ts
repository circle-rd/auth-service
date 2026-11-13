import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, state } = vi.hoisted(() => {
  const state = { results: [] as unknown[][] };
  const terminal = () => Promise.resolve(state.results.shift() ?? []);
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => terminal(),
  };
  return { state, mockDb: { select: () => chain } };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));

const { listOwnerMembers } = await import("./members.js");

beforeEach(() => {
  state.results = [];
});

describe("listOwnerMembers", () => {
  it("groups multiple roles under one member", async () => {
    state.results = [
      [
        {
          userId: "user-a",
          name: "Alice",
          email: "alice@example.test",
          isActive: true,
          role: "admin",
        },
        {
          userId: "user-a",
          name: "Alice",
          email: "alice@example.test",
          isActive: true,
          role: "billing",
        },
        {
          userId: "user-b",
          name: "Bob",
          email: "bob@example.test",
          isActive: false,
          role: null,
        },
      ],
    ];
    const members = await listOwnerMembers("app-a");
    expect(members).toHaveLength(2);
    expect(members[0]).toEqual({
      userId: "user-a",
      name: "Alice",
      email: "alice@example.test",
      isActive: true,
      roles: ["admin", "billing"],
    });
    expect(members[1]).toEqual({
      userId: "user-b",
      name: "Bob",
      email: "bob@example.test",
      isActive: false,
      roles: [],
    });
  });

  it("returns an empty list for an application with no members", async () => {
    state.results = [[]];
    await expect(listOwnerMembers("app-a")).resolves.toEqual([]);
  });
});
