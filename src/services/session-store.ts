import { APIError, type SecondaryStorage } from "better-auth";
import { logger } from "../logger.js";
import type { RedisClient } from "./redis-client.js";
import { incrementWithTtl } from "./redis-counter.js";

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
      reachable(() =>
        incrementWithTtl(client, KEY_PREFIX + key, ttlSeconds * 1000),
      ),
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
