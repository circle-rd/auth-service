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
    eval: vi.fn<
      (
        script: string,
        numberOfKeys: number,
        ...args: (string | number)[]
      ) => Promise<unknown>
    >(async () => 1),
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

  it("increments and arms the TTL in one atomic script", async () => {
    const client = fakeClient();
    const storage = createRedisSecondaryStorage(
      client as unknown as RedisClient,
    );

    await expect(storage.increment("rl", 60)).resolves.toBe(1);

    const [script, numberOfKeys, key, ttlMs] = client.eval.mock.calls[0]!;
    expect(script).toContain("INCR");
    expect(script).toContain("PEXPIRE");
    expect(numberOfKeys).toBe(1);
    expect(key).toBe("auth:session:rl");
    expect(ttlMs).toBe(60_000);
  });

  it("returns the counter value reported by the script", async () => {
    const client = fakeClient();
    client.eval.mockResolvedValueOnce(7);
    const storage = createRedisSecondaryStorage(
      client as unknown as RedisClient,
    );

    await expect(storage.increment("rl", 60)).resolves.toBe(7);
    expect(client.eval).toHaveBeenCalledTimes(1);
  });

  it("answers an increment failure with a 503 SRV_002 API error", async () => {
    const client = fakeClient();
    client.eval.mockRejectedValueOnce(new Error("ECONNRESET"));
    const storage = createRedisSecondaryStorage(
      client as unknown as RedisClient,
    );

    await expect(storage.increment("rl", 60)).rejects.toMatchObject({
      statusCode: 503,
    });
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
