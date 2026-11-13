import { logger } from "../logger.js";

/** Minimal subset of the ioredis client the auth service relies on. */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: (string | number)[]
  ): Promise<unknown>;
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  on(event: "error", listener: (err: unknown) => void): unknown;
  quit(): Promise<unknown>;
}

type RedisConstructor = new (
  url: string,
  options?: Record<string, unknown>,
) => RedisClient;

let clientPromise: Promise<RedisClient> | null = null;

/**
 * The single Redis connection shared by rate limiting and the session store.
 * `ioredis` is loaded lazily so a deployment without `REDIS_URL` never opens a
 * socket and never needs the package; the first call decides the URL for the
 * process lifetime.
 */
export function getRedisClient(redisUrl: string): Promise<RedisClient> {
  clientPromise ??= loadClient(redisUrl);
  return clientPromise;
}

async function loadClient(redisUrl: string): Promise<RedisClient> {
  // Non-literal specifier so TypeScript does not require ioredis to be
  // installed for builds that never set REDIS_URL.
  const specifier = "ioredis";
  let mod: { default: RedisConstructor };
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch {
    throw new Error(
      "REDIS_URL is set but the optional 'ioredis' package is not installed. " +
        "Run `pnpm add ioredis` or unset REDIS_URL.",
    );
  }
  const client = new mod.default(redisUrl, { maxRetriesPerRequest: 1 });
  client.on("error", (err) => {
    logger.error({ err: String(err) }, "[redis] connection error");
  });
  return client;
}

/** Close the shared connection on shutdown. The no-op when Redis is not used. */
export async function closeRedisClient(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise;
  clientPromise = null;
  await client.quit().catch(() => {});
}
