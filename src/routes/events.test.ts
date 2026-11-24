import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eventsRoutes } from "./events.js";
import {
  ADMIN_ROOM,
  MemoryEventBus,
  appRoom,
  orgRoom,
  publishEvent,
  setEventBus,
  userRoom,
  type Room,
} from "../services/event-bus.js";
import type { Audience } from "../services/realtime-audience.js";

/**
 * Exercised over a real listening socket: `app.inject()` cannot be used for a
 * hijacked, never-ending response — it waits for `end`, which an SSE stream
 * never sends. The audience is controlled per user; the delivery decision and
 * the frame format are the real ones.
 */

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const { mockGetSession, mockAudiences } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockAudiences: new Map<string, { rooms: Set<Room>; admin: boolean }>(),
}));

vi.mock("../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock("../services/realtime-audience.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAudience: vi.fn(async (userId: string) => {
    const entry = mockAudiences.get(userId);
    if (!entry) throw new Error(`no audience for ${userId}`);
    return { rooms: entry.rooms, admin: entry.admin } satisfies Audience;
  }),
}));

const KEEP_ALIVE_MS = 60_000;
const TIMEOUT = Symbol("timeout");

let app: FastifyInstance;
let base: string;
let bus: MemoryEventBus;

function grant(userId: string, opts: { admin?: boolean; rooms?: Room[] } = {}) {
  const rooms = new Set<Room>([userRoom(userId), ...(opts.rooms ?? [])]);
  if (opts.admin) rooms.add(ADMIN_ROOM);
  mockAudiences.set(userId, { rooms, admin: opts.admin === true });
  return { id: userId, role: opts.admin ? "admin" : "user" };
}

async function startServer(maxStreamMs?: number): Promise<void> {
  app = Fastify({ logger: false });
  await app.register(eventsRoutes, {
    prefix: "/api/events",
    keepAliveMs: KEEP_ALIVE_MS,
    ...(maxStreamMs ? { maxStreamMs } : {}),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server is not listening on a TCP port");
  }
  base = `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  bus = new MemoryEventBus();
  setEventBus(bus);
  mockGetSession.mockReset();
  mockAudiences.clear();
  await startServer();
});

afterEach(async () => {
  await app.close();
  setEventBus(null);
});

/** Open the stream for `user` and return a reader that accumulates raw frames. */
async function openStream(user: { id: string; role: string }) {
  mockGetSession.mockResolvedValue({ user });
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;

  return {
    res,
    /** Frames received so far. */
    text: () => buffer,
    async readUntil(
      predicate: (text: string) => boolean,
      timeoutMs = 2_000,
    ): Promise<string> {
      if (!reader) throw new Error("response has no body");
      const deadline = Date.now() + timeoutMs;
      while (!predicate(buffer)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || ended) {
          throw new Error(
            `timed out waiting; received ${JSON.stringify(buffer)}`,
          );
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<typeof TIMEOUT>((resolve) =>
            setTimeout(() => resolve(TIMEOUT), remaining),
          ),
        ]);
        if (chunk === TIMEOUT) {
          throw new Error(
            `timed out waiting; received ${JSON.stringify(buffer)}`,
          );
        }
        if (chunk.done) {
          ended = true;
          throw new Error(
            `stream ended early; received ${JSON.stringify(buffer)}`,
          );
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return buffer;
    },
    /** Wait until the server closes the stream. */
    async waitForEnd(timeoutMs = 2_000): Promise<void> {
      if (!reader) throw new Error("response has no body");
      const deadline = Date.now() + timeoutMs;
      while (!ended) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("stream stayed open");
        const chunk = await Promise.race([
          reader.read(),
          new Promise<typeof TIMEOUT>((resolve) =>
            setTimeout(() => resolve(TIMEOUT), remaining),
          ),
        ]);
        if (chunk === TIMEOUT) throw new Error("stream stayed open");
        if (chunk.done) ended = true;
        else buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    close: () => controller.abort(),
  };
}

/** Let the server finish subscribing before the test publishes. */
async function waitForSubscribers(expected: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (bus.subscriberCount !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return bus.subscriberCount;
}

const eventLines = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("event: "));

describe("GET /api/events — authentication", () => {
  it("401 when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await fetch(`${base}/api/events`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "AUTH_001" } });
    expect(bus.subscriberCount).toBe(0);
  });

  it("200 with text/event-stream for a standard user", async () => {
    const user = grant("u-1");
    const stream = await openStream(user);
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    expect(stream.res.headers.get("cache-control")).toContain("no-cache");
    await stream.readUntil((text) => text.includes(": connected"));
    stream.close();
  });
});

describe("GET /api/events — delivery", () => {
  it("frames carry the event name and the instant only, never a room", async () => {
    const user = grant("a-1", { admin: true });
    const stream = await openStream(user);
    await waitForSubscribers(1);

    publishEvent("presence.changed", [ADMIN_ROOM]);
    const text = await stream.readUntil((t) =>
      t.includes("event: presence.changed"),
    );

    expect(text).toMatch(
      /event: presence\.changed\ndata: \d{4}-\d{2}-\d{2}T[^\n]+\n\n/,
    );
    expect(text).not.toMatch(/admin|user:|org:|app:|a-1/);
    stream.close();
  });

  it("an admin receives administration events", async () => {
    const user = grant("a-1", { admin: true });
    const stream = await openStream(user);
    await waitForSubscribers(1);

    publishEvent("login.recorded", [ADMIN_ROOM]);
    await stream.readUntil((t) => t.includes("event: login.recorded"));
    stream.close();
  });

  it("a standard user never receives administration events, even when addressed", async () => {
    const user = grant("u-1");
    const stream = await openStream(user);
    await waitForSubscribers(1);

    publishEvent("login.recorded", [userRoom("u-1")]);
    publishEvent("wallet.changed", [userRoom("u-1")]);
    await stream.readUntil((t) => t.includes("event: wallet.changed"));

    expect(eventLines(stream.text())).toEqual(["event: wallet.changed"]);
    stream.close();
  });

  it("a user hears only events addressed to one of its rooms", async () => {
    const alice = grant("alice");
    grant("bob");
    const stream = await openStream(alice);
    await waitForSubscribers(1);

    publishEvent("wallet.changed", [userRoom("bob")]);
    publishEvent("wallet.changed", [userRoom("alice")]);
    await stream.readUntil((t) => t.includes("event: wallet.changed"));

    expect(eventLines(stream.text())).toHaveLength(1);
    stream.close();
  });

  it("organization members hear their organization, outsiders do not", async () => {
    const member = grant("m-1", { rooms: [orgRoom("org-1")] });
    const outsider = grant("o-1");
    const memberStream = await openStream(member);
    const outsiderStream = await openStream(outsider);
    await waitForSubscribers(2);

    publishEvent("wallet.changed", [orgRoom("org-1")]);
    publishEvent("wallet.changed", [userRoom("o-1")]);
    await memberStream.readUntil((t) => t.includes("event: wallet.changed"));
    await outsiderStream.readUntil((t) => t.includes("event: wallet.changed"));

    expect(eventLines(memberStream.text())).toHaveLength(1);
    expect(eventLines(outsiderStream.text())).toHaveLength(1);
    memberStream.close();
    outsiderStream.close();
  });

  it("enrolled users hear the type-only catalogue events of their application", async () => {
    const enrolled = grant("e-1", { rooms: [appRoom("app-1")] });
    const stranger = grant("s-1");
    const enrolledStream = await openStream(enrolled);
    const strangerStream = await openStream(stranger);
    await waitForSubscribers(2);

    publishEvent("catalogue.changed", [appRoom("app-1")]);
    await enrolledStream.readUntil((t) =>
      t.includes("event: catalogue.changed"),
    );

    expect(strangerStream.text()).not.toContain("catalogue.changed");
    enrolledStream.close();
    strangerStream.close();
  });
});

describe("GET /api/events — closing", () => {
  it("a revoked session ends its own stream and no other", async () => {
    const victim = grant("v-1");
    const other = grant("o-1");
    const victimStream = await openStream(victim);
    const otherStream = await openStream(other);
    await waitForSubscribers(2);

    publishEvent("session.revoked", [ADMIN_ROOM, userRoom("v-1")]);
    await victimStream.waitForEnd();
    publishEvent("wallet.changed", [userRoom("o-1")]);
    await otherStream.readUntil((t) => t.includes("event: wallet.changed"));
    expect(eventLines(otherStream.text())).toEqual(["event: wallet.changed"]);
    otherStream.close();
  });

  it("a changed user ends the stream of that user only, while admins keep theirs", async () => {
    const changed = grant("c-1");
    const admin = grant("a-1", { admin: true });
    const changedStream = await openStream(changed);
    const adminStream = await openStream(admin);
    await waitForSubscribers(2);

    publishEvent("user.changed", [ADMIN_ROOM, userRoom("c-1")]);
    await adminStream.readUntil((t) => t.includes("event: user.changed"));
    await changedStream.waitForEnd();
    publishEvent("wallet.changed", [ADMIN_ROOM]);
    await adminStream.readUntil((t) => t.includes("event: wallet.changed"));
    adminStream.close();
  });

  it("a membership change ends the streams of the organization members", async () => {
    const member = grant("m-1", { rooms: [orgRoom("org-1")] });
    const memberStream = await openStream(member);
    await waitForSubscribers(1);

    publishEvent("organization.changed", [ADMIN_ROOM, orgRoom("org-1")]);
    await memberStream.waitForEnd();
  });

  it("the stream ends at the lifetime cap so rights are re-resolved", async () => {
    await app.close();
    await startServer(80);
    const user = grant("u-1");
    const stream = await openStream(user);
    await stream.waitForEnd(2_000);
  });
});
