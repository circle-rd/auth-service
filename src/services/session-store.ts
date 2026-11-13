import type { SecondaryStorage } from "better-auth";
import type { RedisClient } from "./redis-client.js";

/**
 * Keys written by BetterAuth into `secondaryStorage` — raw session tokens and
 * the per-user `active-sessions-*` index — live under their own prefix so they
 * never collide with rate-limit counters sharing the same Redis.
 */
const KEY_PREFIX = "auth:session:";

/**
 * BetterAuth session mirror on Redis (see `session.storeSessionInDatabase`:
 * Postgres stays the system of record; Redis serves reads and deletes sessions
 * on revocation, so a revoked session is refused on its next read on every
 * instance).
 */
export function createRedisSecondaryStorage(
  client: RedisClient,
): SecondaryStorage {
  return {
    get: (key) => client.get(KEY_PREFIX + key),
    getAndDelete: (key) => client.getdel(KEY_PREFIX + key),
    increment: async (key, ttlSeconds) => {
      const count = await client.incr(KEY_PREFIX + key);
      // The window starts on creation only; later increments never extend it.
      if (count === 1)
        await client.pexpire(KEY_PREFIX + key, ttlSeconds * 1000);
      return count;
    },
    set: async (key, value, ttlSeconds) => {
      if (ttlSeconds && ttlSeconds > 0) {
        await client.set(KEY_PREFIX + key, value, "EX", ttlSeconds);
        return;
      }
      await client.set(KEY_PREFIX + key, value);
    },
    delete: async (key) => {
      await client.del(KEY_PREFIX + key);
    },
  };
}
