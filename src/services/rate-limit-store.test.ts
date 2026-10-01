import { describe, it, expect, afterEach, vi } from "vitest";
import {
  MemoryRateLimitStore,
  createRateLimitStore,
} from "./rate-limit-store.js";

describe("MemoryRateLimitStore", () => {
  const stores: MemoryRateLimitStore[] = [];

  afterEach(async () => {
    for (const s of stores) await s.close();
    stores.length = 0;
    vi.useRealTimers();
  });

  it("allows up to max hits then blocks within the window", async () => {
    const store = new MemoryRateLimitStore();
    stores.push(store);

    expect(await store.hit("k", 2, 60_000)).toBe(true);
    expect(await store.hit("k", 2, 60_000)).toBe(true);
    expect(await store.hit("k", 2, 60_000)).toBe(false);
  });

  it("tracks keys independently", async () => {
    const store = new MemoryRateLimitStore();
    stores.push(store);
    expect(await store.hit("a", 1, 60_000)).toBe(true);
    expect(await store.hit("b", 1, 60_000)).toBe(true);
    expect(await store.hit("a", 1, 60_000)).toBe(false);
  });

  it("resets once the window elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const store = new MemoryRateLimitStore();
    stores.push(store);

    expect(await store.hit("k", 1, 1_000)).toBe(true);
    expect(await store.hit("k", 1, 1_000)).toBe(false);
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    expect(await store.hit("k", 1, 1_000)).toBe(true);
  });
});

describe("createRateLimitStore", () => {
  it("returns the in-memory store when REDIS_URL is unset", async () => {
    const store = await createRateLimitStore();
    expect(store).toBeInstanceOf(MemoryRateLimitStore);
    await store.close();
  });
});
