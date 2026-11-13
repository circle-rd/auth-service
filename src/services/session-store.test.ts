import { describe, expect, it, vi } from "vitest";
import type { RedisClient } from "./redis-client.js";
import { createRedisSecondaryStorage } from "./session-store.js";

function fakeClient() {
  return {
    get: vi.fn<(key: string) => Promise<string | null>>(async () => "value"),
    getdel: vi.fn<(key: string) => Promise<string | null>>(async () => "value"),
    set: vi.fn(async () => "OK"),
    incr: vi.fn<(key: string) => Promise<number>>(async () => 1),
    pexpire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    on: vi.fn(),
    quit: vi.fn(async () => "OK"),
  };
}

describe("createRedisSecondaryStorage", () => {
  it("namespaces every key under auth:session:", async () => {
    const client = fakeClient();
    const storage = createRedisSecondaryStorage(
      client as unknown as RedisClient,
    );

    await storage.get("token-a");
    await storage.delete("token-a");
    await storage.getAndDelete("token-a");

    expect(client.get).toHaveBeenCalledWith("auth:session:token-a");
    expect(client.del).toHaveBeenCalledWith("auth:session:token-a");
    expect(client.getdel).toHaveBeenCalledWith("auth:session:token-a");
  });

  it("writes with an expiry when a TTL is given and without one otherwise", async () => {
    const client = fakeClient();
    const storage = createRedisSecondaryStorage(
      client as unknown as RedisClient,
    );

    await storage.set("token-a", "v", 120);
    await storage.set("index", "v");
    await storage.set("token-b", "v", 0);

    expect(client.set).toHaveBeenNthCalledWith(
      1,
      "auth:session:token-a",
      "v",
      "EX",
      120,
    );
    expect(client.set).toHaveBeenNthCalledWith(2, "auth:session:index", "v");
    expect(client.set).toHaveBeenNthCalledWith(3, "auth:session:token-b", "v");
  });

  it("starts the window on the first increment only", async () => {
    const client = fakeClient();
    const storage = createRedisSecondaryStorage(
      client as unknown as RedisClient,
    );

    client.incr.mockResolvedValueOnce(1);
    await expect(storage.increment("rl", 60)).resolves.toBe(1);
    expect(client.pexpire).toHaveBeenCalledWith("auth:session:rl", 60_000);

    client.incr.mockResolvedValueOnce(2);
    await expect(storage.increment("rl", 60)).resolves.toBe(2);
    expect(client.pexpire).toHaveBeenCalledTimes(1);
  });
});
