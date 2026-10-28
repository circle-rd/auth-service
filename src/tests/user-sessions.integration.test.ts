import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { userRoutes } from "../routes/user.js";
import { createTestApp } from "./helpers/app.js";
import { db } from "../db/index.js";
import { session as sessionTable, user as userTable } from "../db/auth-schema.js";
import { cleanDb } from "./helpers/db.js";
import { makeUserSession } from "./helpers/auth.js";
import { auth } from "../auth.js";

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const app = createTestApp();

beforeAll(async () => {
  await app.register(userRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
});

type SessionLike =
  ReturnType<typeof auth.api.getSession> extends Promise<infer T> ? T : never;

function asUser(id: string) {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeUserSession(id) as unknown as SessionLike,
  );
}

async function seedSession(userId: string, sessionId: string) {
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: userId,
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await db.insert(sessionTable).values({
    id: sessionId,
    token: `token-${sessionId}`,
    userId,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

describe("DELETE /sessions/:id", () => {
  // A missing session is a 404, not a 401: the caller is authenticated, and a
  // 401 would read as "sign in again" to the clients that handle it that way.
  it.each([
    ["does not exist", "no-such-session"],
    ["belongs to another user", "other-session"],
  ])("→ 404 AUTH_016 when the session %s", async (_label, sessionId) => {
    await seedSession("owner", "other-session");
    await seedSession("user-1", "own-session");
    asUser("user-1");

    const res = await app.inject({
      method: "DELETE",
      url: `/sessions/${sessionId}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "AUTH_016" } });
  });
});
