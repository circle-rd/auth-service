import { APIError, type SecondaryStorage } from "better-auth";
import { logger } from "../logger.js";
import type { RedisClient } from "./redis-client.js";

/**
 * Keys written by BetterAuth into `secondaryStorage` — raw session tokens and
 * the per-user `active-sessions-*` index — live under their own prefix so they
 * never collide with rate-limit counters sharing the same Redis.
 */
const KEY_PREFIX = "auth:session:";

/**
 * Run one Redis operation. A failure is raised as a 503 `SRV_002`, not as the
 * generic session error: BetterAuth rethrows API errors unchanged, so the
 * status reaches both the Fastify routes and the BetterAuth endpoints. The
 * caller still fails closed; only the answer becomes honest about the cause.
 */
async function reachable<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    logger.error({ err: String(err) }, "[session-store] redis unavailable");
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "SRV_002",
      message: "Service temporarily unavailable",
    });
  }
}

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
    get: (key) => reachable(() => client.get(KEY_PREFIX + key)),
    getAndDelete: (key) => reachable(() => client.getdel(KEY_PREFIX + key)),
    increment: (key, ttlSeconds) =>
      reachable(async () => {
        const namespaced = KEY_PREFIX + key;
        const ttlMs = Math.max(1, Math.floor(ttlSeconds * 1000));
        // Create the counter with its TTL in one command. A lost expiry can no
        // longer leave a permanent key behind.
        const created = await client.set(namespaced, "1", "PX", ttlMs, "NX");
        if (created !== null) return 1;
        const count = await client.incr(namespaced);
        // The key can expire between SET NX and INCR; only then re-arm it.
        if (count === 1) {
          try {
            await client.pexpire(namespaced, ttlMs);
          } catch (err) {
            await client.del(namespaced).catch(() => {});
            throw err;
          }
        }
        return count;
      }),
    set: (key, value, ttlSeconds) =>
      reachable(async () => {
        if (ttlSeconds && ttlSeconds > 0) {
          await client.set(KEY_PREFIX + key, value, "EX", ttlSeconds);
          return;
        }
        await client.set(KEY_PREFIX + key, value);
      }),
    delete: (key) =>
      reachable(async () => {
        await client.del(KEY_PREFIX + key);
      }),
  };
}
