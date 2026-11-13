import type { RedisClient } from "./redis-client.js";

// INCR recreates expired keys; PTTL < 0 arms an existing key that has no expiry.
const INCREMENT_WITH_TTL = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/**
 * Increment a Redis counter and arm its window in one atomic server-side step.
 * Later increments preserve the window; a legacy key without an expiry (or a
 * key recreated after expiry) receives one.
 */
export async function incrementWithTtl(
  client: RedisClient,
  key: string,
  ttlMs: number,
): Promise<number> {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError(
      `incrementWithTtl: ttlMs must be a positive integer, received ${ttlMs}`,
    );
  }
  return (await client.eval(INCREMENT_WITH_TTL, 1, key, ttlMs)) as number;
}
