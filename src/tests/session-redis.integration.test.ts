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
import { eq } from "drizzle-orm";
import { APIError } from "better-auth";
import type { auth as AuthApi } from "../auth.js";
import type { db as Db } from "../db/index.js";
import type { user as UserTable } from "../db/auth-schema.js";
import type { refreshUserSessionSnapshots as RefreshSnapshots } from "../services/session-snapshot.js";

let redisContainer: StartedTestContainer;
let auth: typeof AuthApi;
let db: typeof Db;
let userTable: typeof UserTable;
let refreshUserSessionSnapshots: typeof RefreshSnapshots;
let redisValue: (key: string) => Promise<string | null>;

beforeAll(async () => {
  redisContainer = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .start();
  const url = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.REDIS_URL = url;

  ({ auth } = await import("../auth.js"));
  ({ db } = await import("../db/index.js"));
  ({ user: userTable } = await import("../db/auth-schema.js"));
  ({ refreshUserSessionSnapshots } = await import(
    "../services/session-snapshot.js"
  ));
  const { getRedisClient } = await import("../services/redis-client.js");
  const client = await getRedisClient(url);
  redisValue = (key) => client.get(key);
}, 120_000);

afterAll(async () => {
  const { closeRedisClient } = await import("../services/redis-client.js");
  await closeRedisClient();
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
