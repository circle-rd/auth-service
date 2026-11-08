import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { makeAuthServer, signUpAndSignIn, type AuthServerHandle } from "./helpers/server.js";
import { cookiesFromResponse } from "./helpers/email-capture.js";
import { cleanDb } from "./helpers/db.js";
import { db } from "../db/index.js";
import {
  oauthClient,
  oauthRefreshToken,
  session as sessionTable,
  user as userTable,
} from "../db/auth-schema.js";
import { eq } from "drizzle-orm";

let handle: AuthServerHandle;

beforeAll(async () => {
  handle = await makeAuthServer();
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  await cleanDb();
  handle.capture.clear();
});

async function signIn(email: string, password: string): Promise<string> {
  const res = await handle.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password },
    headers: { "content-type": "application/json" },
  });
  expect(res.statusCode).toBe(200);
  return cookiesFromResponse(res.headers["set-cookie"]);
}

describe("POST /api/user/sessions/revoke-others", () => {
  it("deletes the other sessions and revokes their offline refresh tokens", async () => {
    const email = "multi@example.com";
    const password = "Password123!";
    const { cookie: firstCookie } = await signUpAndSignIn(handle, {
      email,
      password,
      name: "Multi",
    });
    const secondCookie = await signIn(email, password);

    const firstList = await handle.app.inject({
      method: "GET",
      url: "/api/user/sessions",
      headers: { cookie: firstCookie },
    });
    const secondList = await handle.app.inject({
      method: "GET",
      url: "/api/user/sessions",
      headers: { cookie: secondCookie },
    });
    const firstId = firstList.json<{ currentSessionId: string }>()
      .currentSessionId;
    const secondId = secondList.json<{ currentSessionId: string }>()
      .currentSessionId;
    expect(firstId).not.toBe(secondId);

    const [user] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, email));
    if (!user) throw new Error("test user not found");

    await db.insert(oauthClient).values({
      id: "client-1",
      clientId: "app-slug",
      redirectUris: ["https://example.com/cb"],
    });
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.insert(oauthRefreshToken).values([
      {
        id: "rt-current",
        token: "refresh-current",
        clientId: "app-slug",
        userId: user.id,
        sessionId: firstId,
        scopes: ["offline_access"],
        expiresAt,
        createdAt: new Date(),
      },
      {
        id: "rt-other",
        token: "refresh-other",
        clientId: "app-slug",
        userId: user.id,
        sessionId: secondId,
        scopes: ["offline_access"],
        expiresAt,
        createdAt: new Date(),
      },
      {
        id: "rt-orphan",
        token: "refresh-orphan",
        clientId: "app-slug",
        userId: user.id,
        sessionId: null,
        scopes: ["offline_access"],
        expiresAt,
        createdAt: new Date(),
      },
    ]);

    const revoked = await handle.app.inject({
      method: "POST",
      url: "/api/user/sessions/revoke-others",
      headers: { cookie: firstCookie },
    });
    expect(revoked.statusCode).toBe(204);

    const after = await handle.app.inject({
      method: "GET",
      url: "/api/user/sessions",
      headers: { cookie: firstCookie },
    });
    const body = after.json<{
      sessions: Array<{ id: string }>;
      currentSessionId: string;
    }>();
    expect(body.currentSessionId).toBe(firstId);
    expect(body.sessions.map((session) => session.id)).toEqual([firstId]);

    const rows = await db
      .select({
        id: oauthRefreshToken.id,
        revoked: oauthRefreshToken.revoked,
      })
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.userId, user.id));
    const byId = new Map(rows.map((row) => [row.id, row.revoked]));
    expect(byId.get("rt-current")).toBeNull();
    expect(byId.get("rt-other")).not.toBeNull();
    expect(byId.get("rt-orphan")).not.toBeNull();

    const gone = await db
      .select({ id: sessionTable.id })
      .from(sessionTable)
      .where(eq(sessionTable.id, secondId));
    expect(gone).toHaveLength(0);
  });
});
