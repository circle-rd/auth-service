/**
 * Rate-limit store abstraction for the sensitive auth/email buckets.
 *
 * The default is an in-process counter (single instance). When `REDIS_URL` is
 * set, `createRateLimitStore` lazily loads `ioredis` so the client is only
 * instantiated (and a socket only opened) when Redis is actually configured,
 * and uses the shared atomic increment-with-TTL script so the limit is shared
 * across instances.
 */

import { logger } from "../logger.js";
import { getRedisClient, type RedisClient } from "./redis-client.js";
import { incrementWithTtl } from "./redis-counter.js";

export interface RateLimitStore {
  /**
   * Record one hit for `key`. Returns `true` while the request is within the
   * `max` allowance for the current `windowMs`, `false` once it is exceeded.
   */
  hit(key: string, max: number, windowMs: number): Promise<boolean>;
  close(): Promise<void>;
  readonly name: string;
}

export class MemoryRateLimitStore implements RateLimitStore {
  readonly name = "memory";

  private readonly buckets = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly sweeper: NodeJS.Timeout;

  constructor(sweepMs = 5 * 60_000) {
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now >= bucket.resetAt) this.buckets.delete(key);
      }
    }, sweepMs);
    this.sweeper.unref();
  }

  async hit(key: string, max: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= max;
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.buckets.clear();
  }
}

export class RedisRateLimitStore implements RateLimitStore {
  readonly name = "redis";

  // During a Redis outage we keep enforcing a per-instance limit locally rather
  // than failing open (which would remove all protection) or failing closed
  // (which would block all authentication).
  private readonly fallback = new MemoryRateLimitStore();

  constructor(private readonly client: RedisClient) {}

  async hit(key: string, max: number, windowMs: number): Promise<boolean> {
    try {
      const count = await incrementWithTtl(this.client, key, windowMs);
      return count <= max;
    } catch (err) {
      // Degrade to the in-process limiter; still bounded, no total lockout.
      logger.error(
        { err: String(err) },
        "[rate-limit] redis unavailable, falling back to per-instance limits",
      );
      return this.fallback.hit(key, max, windowMs);
    }
  }

  async close(): Promise<void> {
    await this.fallback.close();
  }
}

export async function createRateLimitStore(
  redisUrl?: string,
): Promise<RateLimitStore> {
  if (!redisUrl) return new MemoryRateLimitStore();
  return new RedisRateLimitStore(await getRedisClient(redisUrl));
}
