import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  makeAuthServer,
  type AuthServerHandle,
} from "./helpers/server.js";
import {
  extractUrl,
  toPath,
  cookiesFromResponse,
} from "./helpers/email-capture.js";
import { openEventStream, frames, type SseStream } from "./helpers/sse.js";
import { getEventBus } from "../services/event-bus.js";
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
  // Hijacked SSE sockets outlive `close()`; tear them down first so the hook
  // does not wait on a connection no client will ever end.
  sseApp.server.closeAllConnections();
  await sseApp.close();
  await handle.cleanup();
});

beforeEach(async () => {
  await cleanDb();
  handle.capture.clear();
});

/**
 * Distinct source address per sign-in. The server rate-limits the credential
 * endpoints per client address (`AUTH_RATE_MAX` hits per minute), and every
 * address here is a test fixture rather than a client, so sharing one address
 * would make this suite fail on its own volume rather than on the code.
 * `trustProxy` is 0 in the test environment, so the injected socket address is
 * what `req.ip` resolves to.
 */
let nextAddress = 1;
function freshAddress(): string {
  nextAddress += 1;
  return `10.13.0.${nextAddress}`;
}

/** The integration helper, with the source address pinned per call. */
async function signUpAndSignInFrom(
  opts: { email: string; password: string; name: string },
  remoteAddress = freshAddress(),
): Promise<{ cookie: string }> {
  const { app, capture } = handle;

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: opts,
    remoteAddress,
    headers: { "content-type": "application/json" },
  });
  if (signUp.statusCode !== 200) {
    throw new Error(`sign-up failed: ${signUp.statusCode} ${signUp.body}`);
  }
  const verifyMsg = capture.last(opts.email);
  if (!verifyMsg) throw new Error("no verification email captured");
  const verifyUrl = extractUrl(verifyMsg.html, (u) =>
    u.includes("/api/auth/verify-email"),
  );
  await app.inject({
    method: "GET",
    url: toPath(verifyUrl),
    remoteAddress,
  });

  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email: opts.email, password: opts.password },
    remoteAddress,
    headers: { "content-type": "application/json" },
  });
  if (signIn.statusCode !== 200) {
    throw new Error(`sign-in failed: ${signIn.statusCode} ${signIn.body}`);
  }
  const cookie = cookiesFromResponse(signIn.headers["set-cookie"]);
  capture.clear();
  return { cookie };
}

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

/**
 * Close the stream and wait for the server to release its subscription. Without
 * the wait the next test would start with the previous one's subscriber still
 * live — the counts below are absolute, and a leak would make them ambiguous.
 */
async function closeStream(stream: SseStream): Promise<void> {
  stream.close();
  await waitForSubscribers(0);
}

/**
 * Snapshot the stream, then wait for one **more** frame of `type` than the
 * snapshot held and return that new frame. Counting is what makes the assertion
 * about the operation under test: a type another step of the same test already
 * announced (the user row a fixture created, for instance) must not be able to
 * satisfy it.
 */
function frameCounter(stream: SseStream) {
  const countIn = (text: string, type: string) =>
    frames(text).filter((f) => f.startsWith(`event: ${type}\n`)).length;

  return {
    /** Frames of `type` already received. Reading the buffer is non-blocking. */
    async count(type: string): Promise<number> {
      return countIn(await stream.readUntil(() => true), type);
    },
    /** Wait for the next frame of `type` and return it verbatim. */
    async next(
      type: string,
      before: number,
      timeoutMs = 5_000,
    ): Promise<string> {
      const text = await stream.readUntil(
        (t) => countIn(t, type) > before,
        timeoutMs,
      );
      const matched = frames(text).filter((f) =>
        f.startsWith(`event: ${type}\n`),
      );
      return matched[matched.length - 1]!;
    },
  };
}

/**
 * Assert that a frame is exactly an event line and a data line, and that the
 * payload of the triggering operation did not travel with it. `leaks` are the
 * literal values the operation handled — an id, an e-mail, a name — that a
 * widened frame would have exposed.
 */
function expectSignalOnlyFrame(frame: string, type: string, leaks: string[]) {
  const lines = frame.replace(/\n+$/, "").split("\n");

  // Exactly two lines: the event name and the timestamp. Anything appended
  // here would be a payload on the wire.
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe(`event: ${type}`);
  // The data line is a bare ISO timestamp and nothing else — a stronger
  // property than any block-list, because a payload cannot be *absent* from it.
  expect(lines[1]).toMatch(/^data: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  for (const leak of leaks) {
    expect(frame).not.toContain(leak);
  }
}

/**
 * Sign an admin up, promote it and open the stream. The sign-in that mints the
 * cookie happens *before* the stream is opened, so nothing it announces can be
 * mistaken for the operation under test.
 */
async function openAdminStream(email = "admin@example.com") {
  const { cookie } = await signUpAndSignInFrom({
    email,
    password: "Password123!",
    name: "Admin",
  });
  await promote(email, "admin");

  const stream = await openEventStream(baseUrl, cookie);
  expect(stream.status).toBe(200);
  await stream.readUntil((text) => text.includes(": connected"));
  expect(await waitForSubscribers(1)).toBe(1);
  return { cookie, stream };
}

describe("GET /api/admin/events — authorization against the real server", () => {
  it("401 without a session and 403 for a global user", async () => {
    const anonymous = await fetch(`${baseUrl}/api/admin/events`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({
      error: { code: "AUTH_001" },
    });

    const { cookie } = await signUpAndSignInFrom({
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
    const { cookie } = await signUpAndSignInFrom({
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

    const counter = frameCounter(stream);
    const frame = await counter.next("login.recorded", 0);
    const lines = frame.replace(/\n+$/, "").split("\n");
    // Exactly two lines: the event name and the timestamp. Anything appended
    // here would be a payload on the wire.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("event: login.recorded");
    const data = lines[1]!.slice("data: ".length);
    expect(Number.isNaN(Date.parse(data))).toBe(false);
    expect(frame).not.toMatch(/admin-1|example\.com|count|user/i);

    await closeStream(stream);
    expect(await waitForSubscribers(0)).toBe(0);
  });
});

/**
 * One test per type added by the widened vocabulary. Each drives the real
 * operation through the admin surface and asserts the announcement reaches an
 * already-connected admin client — the type is not merely declared in the
 * closed set, it is emitted by the operation that changes the state.
 */
describe("GET /api/admin/events — the widened vocabulary", () => {
  it("delivers session.created when a session is really created", async () => {
    const { stream } = await openAdminStream();
    const counter = frameCounter(stream);
    const before = await counter.count("session.created");

    // A second user signs in for real: BetterAuth writes the session row
    // through the hook-wrapped adapter, which is where the type is announced.
    await signUpAndSignInFrom({
      email: "newcomer@example.com",
      password: "Secret-Password-9",
      name: "Newcomer",
    });

    expectSignalOnlyFrame(
      await counter.next("session.created", before),
      "session.created",
      ["newcomer@example.com", "Newcomer", "Secret-Password-9"],
    );
    await closeStream(stream);
  });

  it("delivers session.revoked when a session is really revoked", async () => {
    const { cookie, stream } = await openAdminStream();
    const counter = frameCounter(stream);
    const before = await counter.count("session.revoked");

    // The stream is a hijacked socket: revoking the session that authenticated
    // it does not tear the connection down (the guard ran at connect time), so
    // the session under test can be the stream's own.
    const listed = await handle.app.inject({
      method: "GET",
      url: "/api/user/sessions",
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    const { currentSessionId } = listed.json<{ currentSessionId: string }>();
    expect(currentSessionId).toBeTruthy();

    // The user-facing revocation route funnels into `auth.api.revokeSession`,
    // i.e. the same `internalAdapter.deleteSession` every native BetterAuth
    // revocation path uses.
    const revoked = await handle.app.inject({
      method: "DELETE",
      url: `/api/user/sessions/${currentSessionId}`,
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(204);

    expectSignalOnlyFrame(
      await counter.next("session.revoked", before),
      "session.revoked",
      ["admin@example.com", currentSessionId],
    );
    expect(await waitForSubscribers(1)).toBe(1);
    await closeStream(stream);
  });

  it("delivers session.revoked on the bulk native path too", async () => {
    const { cookie, stream } = await openAdminStream();
    const counter = frameCounter(stream);
    const before = await counter.count("session.revoked");

    // The second family of revocation paths, and the reason the emission point
    // is the `session.delete.after` database hook rather than a route: the
    // native BetterAuth endpoint sweeps the user's sessions through
    // `internalAdapter.deleteUserSessions()`, i.e. `deleteManyWithHooks(...,
    // "session", ...)`, never through the single-row `deleteSession` the
    // previous test drives. A hook covers both; a call site in our own route
    // would cover neither of them.
    const revoked = await handle.app.inject({
      method: "POST",
      url: "/api/auth/revoke-sessions",
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(200);

    expectSignalOnlyFrame(
      await counter.next("session.revoked", before),
      "session.revoked",
      ["admin@example.com"],
    );
    await closeStream(stream);
  });

  it("delivers user.changed when an admin edits a user", async () => {
    const { cookie, stream } = await openAdminStream();
    const counter = frameCounter(stream);

    // An admin may only target a strictly lower-ranked account, so the edit is
    // made against a plain user rather than the admin's own row. The target row
    // is seeded directly: this test is about the admin's edit, and creating the
    // target over HTTP would announce a `user.changed` of its own.
    await db.insert(userTable).values({
      id: "target-1",
      name: "Target",
      email: "target@example.com",
      emailVerified: true,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const before = await counter.count("user.changed");

    const patched = await handle.app.inject({
      method: "PATCH",
      url: "/api/admin/users/target-1",
      payload: { name: "Renamed" },
      headers: { "content-type": "application/json", cookie },
    });
    expect(patched.statusCode).toBe(200);

    expectSignalOnlyFrame(
      await counter.next("user.changed", before),
      "user.changed",
      ["target-1", "target@example.com", "Renamed"],
    );
    await closeStream(stream);
  });

  it("delivers application.changed when an admin creates an application", async () => {
    const { cookie, stream } = await openAdminStream();
    const counter = frameCounter(stream);
    const before = await counter.count("application.changed");

    const created = await handle.app.inject({
      method: "POST",
      url: "/api/admin/applications",
      payload: { name: "New App", slug: "new-app", isPublic: false },
      headers: { "content-type": "application/json", cookie },
    });
    expect(created.statusCode).toBe(201);

    const { clientSecret } = created.json<{ clientSecret?: string }>();
    expect(clientSecret).toBeTruthy();

    expectSignalOnlyFrame(
      await counter.next("application.changed", before),
      "application.changed",
      ["new-app", "New App", clientSecret!],
    );
    await closeStream(stream);
  });

  it("delivers organization.changed when an admin creates an organization", async () => {
    const { cookie, stream } = await openAdminStream();
    const counter = frameCounter(stream);
    const before = await counter.count("organization.changed");

    const created = await handle.app.inject({
      method: "POST",
      url: "/api/admin/organizations",
      payload: { name: "Acme", slug: "acme" },
      headers: { "content-type": "application/json", cookie },
    });
    expect(created.statusCode).toBe(201);

    expectSignalOnlyFrame(
      await counter.next("organization.changed", before),
      "organization.changed",
      ["acme", "Acme", "admin@example.com"],
    );
    await closeStream(stream);
  });
});
