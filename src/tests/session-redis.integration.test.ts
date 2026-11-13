/**
 * Integration test — BetterAuth sessions mirrored to Redis (`REDIS_URL` set).
 *
 * Starts its own Redis container and exports `REDIS_URL` before the
 * application modules are imported, so this file alone runs with the Redis
 * session store while the rest of the suite keeps the database-only path.
 *
 * It asserts the three session semantics the mirror must preserve: a revoked
 * session is refused on its next read, a user-wide revocation clears every
 * mirror entry, and a user change reaches a live session only when the
 * committed write is followed by a snapshot refresh.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { createServer, connect, type Server } from "node:net";
import { eq } from "drizzle-orm";
import { APIError } from "better-auth";
import type { auth as AuthApi } from "../auth.js";
import type { db as Db } from "../db/index.js";
import type { user as UserTable } from "../db/auth-schema.js";
import type {
  mutateUserAndRefreshSnapshots as Mutate,
  refreshUserSessionSnapshots as RefreshSnapshots,
} from "../services/session-snapshot.js";

interface RedisProxy {
  url: string;
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}

let redisContainer: StartedTestContainer;
let proxy: RedisProxy;
let auth: typeof AuthApi;
let db: typeof Db;
let userTable: typeof UserTable;
let refreshUserSessionSnapshots: typeof RefreshSnapshots;
let mutateUserAndRefreshSnapshots: typeof Mutate;
let redisValue: (key: string) => Promise<string | null>;

async function startRedisProxy(
  targetHost: string,
  targetPort: number,
): Promise<RedisProxy> {
  const sockets = new Set<ReturnType<typeof connect>>();
  let server: Server | null = null;
  let port = 0;

  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const next = createServer((client) => {
        const upstream = connect(targetPort, targetHost);
        sockets.add(client);
        sockets.add(upstream);
        const close = (): void => {
          sockets.delete(client);
          sockets.delete(upstream);
          client.destroy();
          upstream.destroy();
        };
        client.on("error", close);
        upstream.on("error", close);
        client.on("close", close);
        upstream.on("close", close);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      next.once("error", reject);
      next.listen(port, "127.0.0.1", () => {
        const address = next.address();
        if (!address || typeof address === "string") {
          reject(new Error("proxy did not bind a TCP port"));
          return;
        }
        port = address.port;
        server = next;
        resolve();
      });
    });

  await listen();
  return {
    get url() {
      return `redis://127.0.0.1:${port}`;
    },
    async pause() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const current = server;
      server = null;
      if (current) {
        await new Promise<void>((resolve) => current.close(() => resolve()));
      }
    },
    async resume() {
      await listen();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const current = server;
      server = null;
      if (current) {
        await new Promise<void>((resolve) => current.close(() => resolve()));
      }
    },
  };
}

beforeAll(async () => {
  redisContainer = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .start();
  proxy = await startRedisProxy(
    redisContainer.getHost(),
    redisContainer.getMappedPort(6379),
  );
  process.env.REDIS_URL = proxy.url;

  ({ auth } = await import("../auth.js"));
  ({ db } = await import("../db/index.js"));
  ({ user: userTable } = await import("../db/auth-schema.js"));
  ({ refreshUserSessionSnapshots, mutateUserAndRefreshSnapshots } =
    await import("../services/session-snapshot.js"));
  const { getRedisClient } = await import("../services/redis-client.js");
  const client = await getRedisClient(proxy.url);
  redisValue = (key) => client.get(key);
}, 120_000);

afterAll(async () => {
  const { closeRedisClient } = await import("../services/redis-client.js");
  await closeRedisClient();
  await proxy?.close();
  await redisContainer?.stop();
  delete process.env.REDIS_URL;
});

async function createUser(label: string): Promise<string> {
  const id = `redis-${label}-${Date.now()}`;
  await db.insert(userTable).values({
    id,
    name: label,
    email: `${id}@example.com`,
    emailVerified: true,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function waitForRedis<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await operation();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe("session mirror on Redis", () => {
  it("stores the session copy under the auth namespace", async () => {
    const ctx = await auth.$context;
    const userId = await createUser("namespace");
    const session = await ctx.internalAdapter.createSession(userId, false);

    expect(await redisValue(`auth:session:${session!.token}`)).not.toBeNull();
  });

  it("refuses a revoked session on its next read", async () => {
    const ctx = await auth.$context;
    const userId = await createUser("revoke-one");
    const session = await ctx.internalAdapter.createSession(userId, false);
    expect(await ctx.internalAdapter.findSession(session!.token)).not.toBeNull();

    await ctx.internalAdapter.deleteSession(session!.token);

    expect(await ctx.internalAdapter.findSession(session!.token)).toBeNull();
    expect(await redisValue(`auth:session:${session!.token}`)).toBeNull();
  });

  it("clears every mirror entry on a user-wide revocation", async () => {
    const ctx = await auth.$context;
    const userId = await createUser("revoke-all");
    const a = await ctx.internalAdapter.createSession(userId, false);
    const b = await ctx.internalAdapter.createSession(userId, false);

    await ctx.internalAdapter.deleteUserSessions(userId);

    expect(await ctx.internalAdapter.findSession(a!.token)).toBeNull();
    expect(await ctx.internalAdapter.findSession(b!.token)).toBeNull();
  });

  it("propagates a role change only once the snapshot is refreshed", async () => {
    const ctx = await auth.$context;
    const userId = await createUser("role");
    const session = await ctx.internalAdapter.createSession(userId, false);
    expect((await ctx.internalAdapter.findSession(session!.token))?.user.role).toBe(
      "user",
    );

    // The admin path writes the row directly, bypassing the adapter.
    await db
      .update(userTable)
      .set({ role: "admin" })
      .where(eq(userTable.id, userId));
    expect((await ctx.internalAdapter.findSession(session!.token))?.user.role).toBe(
      "user",
    );

    await refreshUserSessionSnapshots(ctx.internalAdapter, userId);

    expect((await ctx.internalAdapter.findSession(session!.token))?.user.role).toBe(
      "admin",
    );
  });

  it("propagates a ban through the adapter to a live session", async () => {
    const ctx = await auth.$context;
    const userId = await createUser("ban");
    const session = await ctx.internalAdapter.createSession(userId, false);

    await ctx.internalAdapter.updateUser(userId, { banned: true });

    expect(
      (await ctx.internalAdapter.findSession(session!.token))?.user.banned,
    ).toBe(true);
  });

  it("refuses a role/verification demotion while Redis is down instead of committing a stale snapshot", async () => {
    const ctx = await auth.$context;
    const userId = await createUser("mutation-outage");
    await db
      .update(userTable)
      .set({ role: "admin" })
      .where(eq(userTable.id, userId));
    const session = await ctx.internalAdapter.createSession(userId, false);
    expect(
      (await ctx.internalAdapter.findSession(session!.token))?.user,
    ).toMatchObject({ role: "admin", emailVerified: true });

    await proxy.pause();
    const err = await mutateUserAndRefreshSnapshots(
      ctx.internalAdapter,
      userId,
      async (tx) => {
        await tx
          .update(userTable)
          .set({ role: "user", emailVerified: false })
          .where(eq(userTable.id, userId));
      },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(503);

    // The mutation is rolled back: a demotion the snapshot refresh could not
    // publish never reaches the database, so the admin can retry safely.
    const [row] = await db
      .select({
        role: userTable.role,
        emailVerified: userTable.emailVerified,
      })
      .from(userTable)
      .where(eq(userTable.id, userId));
    expect(row).toMatchObject({ role: "admin", emailVerified: true });

    await proxy.resume();
    const restored = await waitForRedis(() =>
      ctx.internalAdapter.findSession(session!.token),
    );
    expect(restored?.user).toMatchObject({
      role: "admin",
      emailVerified: true,
    });
  }, 60_000);

  it("serialises concurrent snapshot refreshes to the committed row", async () => {
    const ctx = await auth.$context;
    const userId = await createUser("concurrent");
    const session = await ctx.internalAdapter.createSession(userId, false);

    const setRole = (role: string) =>
      mutateUserAndRefreshSnapshots(
        ctx.internalAdapter,
        userId,
        async (tx) => {
          await tx
            .update(userTable)
            .set({ role })
            .where(eq(userTable.id, userId));
        },
      );
    await Promise.all([setRole("admin"), setRole("user")]);

    const [row] = await db
      .select({ role: userTable.role })
      .from(userTable)
      .where(eq(userTable.id, userId));
    const live = await ctx.internalAdapter.findSession(session!.token);
    expect(live?.user.role).toBe(row!.role);
  }, 60_000);

  it("keeps the shared Redis session store alive across server rebuilds", async () => {
    const { buildServer } = await import("../server.js");
    const ctx = await auth.$context;
    const userId = await createUser("rebuild");
    const session = await ctx.internalAdapter.createSession(userId, false);

    const first = await buildServer();
    await first.close();
    expect(await ctx.internalAdapter.findSession(session!.token)).not.toBeNull();

    const second = await buildServer();
    expect(await ctx.internalAdapter.findSession(session!.token)).not.toBeNull();
    await second.close();
  }, 60_000);

  it("answers 503 SRV_002 when Redis is unreachable, and grants nothing", async () => {
    const ctx = await auth.$context;
    const userId = await createUser("outage");
    const session = await ctx.internalAdapter.createSession(userId, false);
    expect(await ctx.internalAdapter.findSession(session!.token)).not.toBeNull();

    await redisContainer.stop();

    const err = await ctx.internalAdapter.findSession(session!.token).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(503);
    expect((err as APIError).body).toMatchObject({ code: "SRV_002" });
  }, 60_000);
});
