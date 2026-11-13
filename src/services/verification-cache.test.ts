import { describe, expect, it, vi } from "vitest";
import { VerificationCache } from "./verification-cache.js";

const fetcher = vi.fn();

async function tick(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("VerificationCache", () => {
  it("fetches once and serves later getters from the entry", async () => {
    const cache = new VerificationCache<number>(
      "test",
      60_000,
      async () => (fetcher(), 7),
    );
    await expect(cache.get()).resolves.toBe(7);
    await expect(cache.get()).resolves.toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent getters on one fetch", async () => {
    let calls = 0;
    const cache = new VerificationCache<number>(
      "test",
      60_000,
      async () => (await tick(20), ++calls),
    );
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
    fetcher.mockClear();
  });
  it("refetches past the TTL, and always when the TTL is zero", async () => {
    const cache = new VerificationCache<number>(
      "test",
      10,
      async () => (fetcher(), 1),
    );
    await cache.get();
    await tick(15);
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);

    const noCache = new VerificationCache<number>(
      "test",
      0,
      async () => (fetcher(), 1),
    );
    await noCache.get();
    await noCache.get();
    expect(fetcher).toHaveBeenCalledTimes(4);
    fetcher.mockClear();
  });

  it("forceRefresh stores a fresh entry and honours one refetch per cooldown", async () => {
    const cache = new VerificationCache<number>(
      "test",
      60_000,
      async () => (fetcher(), 1),
      50,
    );
    await cache.forceRefresh();
    await expect(cache.forceRefresh()).rejects.toThrow(/cooldown/);
    await tick(55);
    await cache.forceRefresh();
    // get() serves the fresh forced entry; invalidate() re-owns it.
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
    cache.invalidate();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps a fetch that raced an invalidation stale", async () => {
    // The fetch captured the pre-invalidation generation: whatever it
    // returns may predate the change, so it is never served as fresh.
    let calls = 0;
    const cache = new VerificationCache<number>(
      "test",
      60_000,
      async () => (await tick(10), ++calls),
    );
    const first = cache.get();
    cache.invalidate();
    await first;
    await cache.get();
    expect(calls).toBe(2);
  });

  it("invalidate moves staleness forward without needing forceRefresh", async () => {
    const cache = new VerificationCache<number>(
      "test",
      60_000,
      async () => (fetcher(), 1),
    );
    await cache.get();
    cache.invalidate();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
