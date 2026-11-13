import { APIError } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import type { RedisClient } from "./redis-client.js";
import { createRedisSecondaryStorage } from "./session-store.js";

function fakeClient() {
  return {
    get: vi.fn<(key: string) => Promise<string | null>>(async () => "value"),
    getdel: vi.fn<(key: string) => Promise<string | null>>(async () => "value"),
    set: vi.fn<
      (
        key: string,
        value: string,
        ...args: (string | number)[]
      ) => Promise<unknown>
    >(async () => "OK"),
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

  it("creates the counter with its expiry atomically", async () => {
    const client = fakeClient();
    const storage = createRedisSecondaryStorage(
      client as unknown as RedisClient,
    );

    await expect(storage.increment("rl", 60)).resolves.toBe(1);

    expect(client.set).toHaveBeenCalledWith(
      "auth:session:rl",
      "1",
      "PX",
      60_000,
      "NX",
    );
    expect(client.incr).not.toHaveBeenCalled();
    expect(client.pexpire).not.toHaveBeenCalled();
  });

  it("increments an existing counter without extending its window", async () => {
    const client = fakeClient();
    client.set.mockResolvedValueOnce(null);
    client.incr.mockResolvedValueOnce(2);
    const storage = createRedisSecondaryStorage(
      client as unknown as RedisClient,
    );

    await expect(storage.increment("rl", 60)).resolves.toBe(2);

    expect(client.incr).toHaveBeenCalledWith("auth:session:rl");
    expect(client.pexpire).not.toHaveBeenCalled();
  });

  it("re-arms the expiry when the key expires between SET NX and INCR", async () => {
    const client = fakeClient();
    client.set.mockResolvedValueOnce(null);
    client.incr.mockResolvedValueOnce(1);
    const storage = createRedisSecondaryStorage(
      client as unknown as RedisClient,
    );

    await expect(storage.increment("rl", 60)).resolves.toBe(1);
    expect(client.pexpire).toHaveBeenCalledWith("auth:session:rl", 60_000);
  });

  it("deletes the counter when the race-window expiry cannot be set", async () => {
    const client = fakeClient();
    client.set.mockResolvedValueOnce(null);
    client.incr.mockResolvedValueOnce(1);
    client.pexpire.mockRejectedValueOnce(new Error("ECONNRESET"));
    const storage = createRedisSecondaryStorage(
      client as unknown as RedisClient,
    );

    await expect(storage.increment("rl", 60)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(client.del).toHaveBeenCalledWith("auth:session:rl");
  });

  it("answers a Redis failure with a 503 SRV_002 API error", async () => {
    const client = fakeClient();
    client.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const storage = createRedisSecondaryStorage(
      client as unknown as RedisClient,
    );

    let err: APIError | undefined;
    try {
      await storage.get("token-a");
    } catch (caught) {
      err = caught as APIError;
    }

    expect(err).toBeInstanceOf(APIError);
    expect(err?.statusCode).toBe(503);
    expect(err?.body).toMatchObject({ code: "SRV_002" });
  });
});
