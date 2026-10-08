import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  makeAuthServer,
  signUpAndSignIn,
  type AuthServerHandle,
} from "./helpers/server.js";
import { openEventStream } from "./helpers/sse.js";
import { getEventBus, publishEvent } from "../services/event-bus.js";
import { recordLogin } from "../services/login-history.js";
import { buildServer } from "../server.js";
import { cleanDb } from "./helpers/db.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { eq } from "drizzle-orm";

/**
 * End-to-end coverage of the admin real-time channel against the real server,
 * the real BetterAuth session resolution and the real database.
 *
 * `makeAuthServer()` exists to drive `app.inject()`, which cannot read a
 * hijacked SSE response (it waits for `end`, which an SSE stream never sends),
 * so the stream itself is opened over a real socket against a second instance
 * of the same server bound to an ephemeral port. Both instances share the
 * process-wide event bus installed by `buildServer()`.
 */

let handle: AuthServerHandle;
let sseApp: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  handle = await makeAuthServer();
  sseApp = await buildServer();
  await sseApp.listen({ port: 0, host: "127.0.0.1" });
  const address = sseApp.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("SSE test server is not listening on a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await sseApp.close();
  await handle.cleanup();
});

beforeEach(async () => {
  await cleanDb();
  handle.capture.clear();
});

async function promote(email: string, role: string): Promise<void> {
  await db.update(userTable).set({ role }).where(eq(userTable.email, email));
}

async function waitForSubscribers(expected: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (getEventBus().subscriberCount !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getEventBus().subscriberCount;
}

describe("GET /api/admin/events — authorization against the real server", () => {
  it("401 without a session and 403 for a global user", async () => {
    const anonymous = await fetch(`${baseUrl}/api/admin/events`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({
      error: { code: "AUTH_001" },
    });

    const { cookie } = await signUpAndSignIn(handle, {
      email: "user@example.com",
      password: "Password123!",
      name: "User",
    });
    const asUser = await fetch(`${baseUrl}/api/admin/events`, {
      headers: { cookie },
    });
    expect(asUser.status).toBe(403);
    expect(await asUser.json()).toMatchObject({ error: { code: "AUTH_011" } });

    // The standard user — the `/profile` page — never holds a subscription.
    expect(getEventBus().subscriberCount).toBe(0);
  });

  it("200 for an admin, and the stream delivers login.recorded", async () => {
    const { cookie } = await signUpAndSignIn(handle, {
      email: "admin@example.com",
      password: "Password123!",
      name: "Admin",
    });
    await promote("admin@example.com", "admin");

    const stream = await openEventStream(baseUrl, cookie);
    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain("text/event-stream");
    await stream.readUntil((text) => text.includes(": connected"));
    expect(await waitForSubscribers(1)).toBe(1);

    // A real login: writes the row and announces it, exactly as the session
    // hook does after a dashboard sign-in.
    await recordLogin({ userId: "admin-1" });

    const text = await stream.readUntil((t) =>
      t.includes("event: login.recorded"),
    );
    const start = text.indexOf("event: login.recorded");
    const frame = text.slice(start, text.indexOf("\n\n", start));
    const lines = frame.split("\n");
    // Exactly two lines: the event name and the timestamp. Anything appended
    // here would be a payload on the wire.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("event: login.recorded");
    const data = lines[1]!.slice("data: ".length);
    expect(Number.isNaN(Date.parse(data))).toBe(false);
    expect(frame).not.toMatch(/admin-1|example\.com|count|user/i);

    stream.close();
    expect(await waitForSubscribers(0)).toBe(0);
  });
});

describe("event vocabulary — all six types reach the stream", () => {
  let cookie: string;

  beforeAll(async () => {
    const { cookie: c } = await signUpAndSignIn(handle, {
      email: "vocab-admin@example.com",
      password: "Password123!",
      name: "Vocab Admin",
    });
    await promote("vocab-admin@example.com", "admin");
    cookie = c;
  });

  it.each([
    "login.recorded",
    "session.created",
    "session.revoked",
    "user.changed",
    "application.changed",
    "organization.changed",
  ])("delivers %s with a parseable timestamp and no payload", async (type) => {
    const stream = await openEventStream(baseUrl, cookie);
    await stream.readUntil((text) => text.includes(": connected"));
    expect(await waitForSubscribers(1)).toBe(1);

    if (type === "login.recorded") {
      await recordLogin({ userId: "vocab-test" });
    } else {
      publishEvent(type);
    }

    const text = await stream.readUntil((t) => t.includes(`event: ${type}`));
    const start = text.indexOf(`event: ${type}`);
    const frame = text.slice(start, text.indexOf("\n\n", start));
    const lines = frame.split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`event: ${type}`);
    const data = lines[1]!.slice("data: ".length);
    expect(Number.isNaN(Date.parse(data))).toBe(false);
    expect(frame).not.toMatch(/vocab-test|example\.com|count|user/i);

    stream.close();
    expect(await waitForSubscribers(0)).toBe(0);
  });
});
