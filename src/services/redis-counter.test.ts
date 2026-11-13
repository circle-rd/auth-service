import { describe, expect, it, vi } from "vitest";
import { incrementWithTtl } from "./redis-counter.js";
import type { RedisClient } from "./redis-client.js";

function fakeClient(count = 1) {
  return {
    eval: vi.fn<
      (
        script: string,
        numberOfKeys: number,
        ...args: (string | number)[]
      ) => Promise<unknown>
    >(async () => count),
  };
}

describe("incrementWithTtl", () => {
  it("runs the atomic script with a positive whole millisecond TTL", async () => {
    const client = fakeClient(3);

    await expect(
      incrementWithTtl(client as unknown as RedisClient, "bucket", 60_000),
    ).resolves.toBe(3);

    const [script, numberOfKeys, key, ttlMs] = client.eval.mock.calls[0]!;
    expect(script).toContain("INCR");
    expect(script).toContain("PEXPIRE");
    expect(numberOfKeys).toBe(1);
    expect(key).toBe("bucket");
    expect(ttlMs).toBe(60_000);
  });

  it.each([0, -1, 1.5])(
    "rejects invalid TTL %s without calling Redis",
    async (ttl) => {
      const client = fakeClient();

      await expect(
        incrementWithTtl(client as unknown as RedisClient, "bucket", ttl),
      ).rejects.toBeInstanceOf(RangeError);
      expect(client.eval).not.toHaveBeenCalled();
    },
  );
});
