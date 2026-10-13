import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  found: [] as unknown[],
  unsafe: vi.fn(async (_q: string): Promise<void> => undefined),
  end: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock("postgres", () => ({
  default: () =>
    Object.assign(async () => m.found, { unsafe: m.unsafe, end: m.end }),
}));

import { ensureDatabase } from "./litellm-database.js";

beforeEach(() => {
  vi.clearAllMocks();
  m.found = [];
});

describe("ensureDatabase", () => {
  it("creates a missing database", async () => {
    expect(await ensureDatabase("postgres://x", "litellm")).toBe("created");
    expect(m.unsafe).toHaveBeenCalledWith('CREATE DATABASE "litellm"');
    expect(m.end).toHaveBeenCalled();
  });

  it("leaves an existing database alone", async () => {
    m.found = [{ "?column?": 1 }];
    expect(await ensureDatabase("postgres://x", "litellm")).toBe("exists");
    expect(m.unsafe).not.toHaveBeenCalled();
  });

  it("tolerates a concurrent creation, fails on other errors", async () => {
    m.unsafe.mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "42P04" }),
    );
    expect(await ensureDatabase("postgres://x", "litellm")).toBe("exists");
    m.unsafe.mockRejectedValueOnce(
      Object.assign(new Error("perm"), { code: "42501" }),
    );
    await expect(ensureDatabase("postgres://x", "litellm")).rejects.toThrow(
      "perm",
    );
    expect(m.end).toHaveBeenCalledTimes(2);
  });

  it("refuses a name that is not a plain identifier", async () => {
    await expect(ensureDatabase("postgres://x", 'a"; DROP')).rejects.toThrow(
      /Invalid database name/,
    );
  });
});
