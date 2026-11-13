import { describe, it, expect, afterEach, vi } from "vitest";
import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  createRateLimitStore,
} from "./rate-limit-store.js";
import type { RedisClient } from "./redis-client.js";

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

describe("RedisRateLimitStore", () => {
  function fakeClient(...counts: number[]) {
    const evalMock = vi.fn<
      (
        script: string,
        numberOfKeys: number,
        ...args: (string | number)[]
      ) => Promise<unknown>
    >(async () => counts.shift() ?? 1);
    return { eval: evalMock };
  }

  it("enforces the limit through the shared atomic counter", async () => {
    const client = fakeClient(1, 2, 3);
    const store = new RedisRateLimitStore(client as unknown as RedisClient);

    await expect(store.hit("bucket", 2, 60_000)).resolves.toBe(true);
    await expect(store.hit("bucket", 2, 60_000)).resolves.toBe(true);
    await expect(store.hit("bucket", 2, 60_000)).resolves.toBe(false);

    expect(client.eval).toHaveBeenCalledTimes(3);
    const [, numberOfKeys, key, ttlMs] = client.eval.mock.calls[0]!;
    expect(numberOfKeys).toBe(1);
    expect(key).toBe("bucket");
    expect(ttlMs).toBe(60_000);
    await store.close();
  });

  it("falls back to per-instance limits when Redis fails", async () => {
    const client = fakeClient();
    client.eval.mockRejectedValue(new Error("ECONNREFUSED"));
    const store = new RedisRateLimitStore(client as unknown as RedisClient);

    await expect(store.hit("bucket", 1, 60_000)).resolves.toBe(true);
    await expect(store.hit("bucket", 1, 60_000)).resolves.toBe(false);
    await store.close();
  });
});
