/**
 * Rate-limit store abstraction for the sensitive auth/email buckets.
 *
 * The default is an in-process counter (single instance). When `REDIS_URL` is
 * set, `createRateLimitStore` lazily loads `ioredis` so the client is only
 * instantiated (and a socket only opened) when Redis is actually configured,
 * and uses an atomic INCR + PEXPIRE pair so the limit is shared across
 * instances.
 */

import { logger } from "../logger.js";

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

/** Minimal subset of the ioredis client the store relies on. */
interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<unknown>;
  quit(): Promise<unknown>;
}

export class RedisRateLimitStore implements RateLimitStore {
  readonly name = "redis";

  // During a Redis outage we keep enforcing a per-instance limit locally rather
  // than failing open (which would remove all protection) or failing closed
  // (which would block all authentication).
  private readonly fallback = new MemoryRateLimitStore();

  constructor(private readonly client: RedisLike) {}

  async hit(key: string, max: number, windowMs: number): Promise<boolean> {
    try {
      const count = await this.client.incr(key);
      // Set the TTL only on the first hit of the window; subsequent INCRs
      // must not extend the window.
      if (count === 1) await this.client.pexpire(key, windowMs);
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
    await this.client.quit().catch(() => {});
    await this.fallback.close();
  }
}

export async function createRateLimitStore(
  redisUrl?: string,
): Promise<RateLimitStore> {
  if (!redisUrl) return new MemoryRateLimitStore();

  // Non-literal specifier so TypeScript does not require ioredis to be
  // installed for the default build.
  const specifier = "ioredis";
  let mod: {
    default: new (url: string, options?: Record<string, unknown>) => RedisLike;
  };
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch {
    throw new Error(
      "REDIS_URL is set but the optional 'ioredis' package is not installed. " +
        "Run `pnpm add ioredis` or unset REDIS_URL.",
    );
  }
  const client = new mod.default(redisUrl, { maxRetriesPerRequest: 1 });
  return new RedisRateLimitStore(client);
}
