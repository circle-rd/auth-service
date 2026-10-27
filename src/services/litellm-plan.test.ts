import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ rows: [] as unknown[][] }));

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

import {
  planSlug,
  planSlugConflict,
  planTeamAlias,
  planTeamId,
} from "./litellm-plan.js";

beforeEach(() => {
  m.rows = [];
});

describe("planSlug", () => {
  it("lowercases and replaces every non-alphanumeric run with a dash", () => {
    expect(planSlug("Free")).toBe("free");
    expect(planSlug("Premium Plus")).toBe("premium-plus");
    expect(planSlug("Pro/Enterprise")).toBe("pro-enterprise");
    expect(planSlug("  --Edges--  ")).toBe("edges");
  });

  it("falls back to 'plan' when nothing is left", () => {
    expect(planSlug("!!!!")).toBe("plan");
  });
});

describe("planTeamId", () => {
  it("scopes the plan slug to the application", () => {
    expect(planTeamId("my-app", "Premium")).toBe("my-app:premium");
  });
});

describe("planTeamAlias", () => {
  it("keeps the human-readable plan name", () => {
    expect(planTeamAlias("My App", "Premium")).toBe("My App - Premium");
  });
});

describe("planSlugConflict", () => {
  it("detects a slug another plan of the application already uses", async () => {
    m.rows = [[{ id: "p1", name: "Free" }]];
    expect(await planSlugConflict("app", "free")).toBe(true);
  });

  it("ignores the plan being renamed", async () => {
    m.rows = [[{ id: "p1", name: "Free" }]];
    expect(await planSlugConflict("app", "free", "p1")).toBe(false);
  });

  it("returns false when no other plan collides", async () => {
    m.rows = [[{ id: "p1", name: "Free" }]];
    expect(await planSlugConflict("app", "Premium")).toBe(false);
  });
});
