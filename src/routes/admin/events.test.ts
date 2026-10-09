import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eventsRoutes } from "./events.js";
import { MemoryEventBus, setEventBus } from "../../services/event-bus.js";

/**
 * The channel is exercised over a real listening socket: `app.inject()` cannot
 * be used for a hijacked, never-ending response — it waits for `end`, which an
 * SSE stream never sends. Every assertion below therefore runs against real
 * HTTP, including the authorization cases the issue makes blocking.
 */

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }));

vi.mock("../../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

const KEEP_ALIVE_MS = 40;
const TIMEOUT = Symbol("timeout");

let app: FastifyInstance;
let base: string;
let bus: MemoryEventBus;

async function startServer(): Promise<void> {
  app = Fastify({ logger: false });
  await app.register(eventsRoutes, {
    prefix: "/api/admin/events",
    keepAliveMs: KEEP_ALIVE_MS,
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
  await startServer();
});

afterEach(async () => {
  await app.close();
  setEventBus(null);
});

/** Open the admin stream and return a reader that accumulates raw frames. */
async function openStream(signal?: AbortSignal) {
  const res = await fetch(`${base}/api/admin/events`, {
    headers: { accept: "text/event-stream" },
    ...(signal ? { signal } : {}),
  });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    res,
    /** Accumulate frames until `predicate` matches; reject on timeout. */
    async readUntil(
      predicate: (text: string) => boolean,
      timeoutMs = 2_000,
    ): Promise<string> {
      if (!reader) throw new Error("response has no body");
      const deadline = Date.now() + timeoutMs;
      while (!predicate(buffer)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
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
          throw new Error(
            `stream ended early; received ${JSON.stringify(buffer)}`,
          );
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return buffer;
    },
  };
}

/** Poll until the bus holds `expected` subscribers, or the deadline passes. */
async function waitForSubscribers(
  expected: number,
  timeoutMs = 2_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (bus.subscriberCount !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return bus.subscriberCount;
}

describe("GET /api/admin/events — authorization", () => {
  it("401 when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await fetch(`${base}/api/admin/events`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "AUTH_001" } });
    expect(bus.subscriberCount).toBe(0);
  });

  it("403 for an authenticated non-admin user", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u-1", role: "user" } });
    const res = await fetch(`${base}/api/admin/events`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "AUTH_011" } });
    expect(bus.subscriberCount).toBe(0);
  });

  it("200 with text/event-stream for an admin", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "a-1", role: "admin" } });
    const controller = new AbortController();
    const stream = await openStream(controller.signal);

    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    expect(stream.res.headers.get("cache-control")).toContain("no-cache");
    await stream.readUntil((text) => text.includes(": connected"));
    controller.abort();
  });

  it("200 with text/event-stream for a superadmin", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "sa-1", role: "superadmin" },
    });
    const controller = new AbortController();
    const stream = await openStream(controller.signal);

    expect(stream.res.status).toBe(200);
    await stream.readUntil((text) => text.includes(": connected"));
    controller.abort();
  });
});

describe("GET /api/admin/events — delivery", () => {
  it("delivers a login.recorded frame whose only content is the event name and a timestamp", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "a-1", role: "admin" } });
    const controller = new AbortController();
    const stream = await openStream(controller.signal);
    await stream.readUntil((text) => text.includes(": connected"));

    bus.publish("login.recorded");
    const text = await stream.readUntil((t) =>
      t.includes("event: login.recorded"),
    );

    const start = text.indexOf("event: login.recorded");
    // One complete frame: `event:` line, `data:` line, blank line terminator.
    const frame = text.slice(start, text.indexOf("\n\n", start));
    const lines = frame.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("event: login.recorded");
    expect(lines[1]!.startsWith("data: ")).toBe(true);

    const data = lines[1]!.slice("data: ".length);
    expect(Number.isNaN(Date.parse(data))).toBe(false);

    // The security property of the whole design: a frame names an event type
    // and, at most, when it happened — never a user id, an e-mail, a count or
    // any other field of the row that triggered it.
    expect(frame).not.toMatch(/user|email|count|session|ip/i);

    controller.abort();
  });

  it("keeps an idle stream alive with comment frames", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "a-1", role: "admin" } });
    const controller = new AbortController();
    const stream = await openStream(controller.signal);

    const text = await stream.readUntil(
      (t) => t.includes(": keep-alive"),
      KEEP_ALIVE_MS * 25,
    );
    expect(text).toContain(": keep-alive\n\n");
    controller.abort();
  });
});

describe("GET /api/admin/events — subscription lifecycle", () => {
  it("drops the subscription when the client disconnects", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "a-1", role: "admin" } });
    const controller = new AbortController();
    const stream = await openStream(controller.signal);
    await stream.readUntil((text) => text.includes(": connected"));
    expect(bus.subscriberCount).toBe(1);

    controller.abort();
    expect(await waitForSubscribers(0)).toBe(0);
  });

  it("does not accumulate subscribers across reconnections", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "a-1", role: "admin" } });

    // `EventSource` reconnects on its own, so the same client keeps coming
    // back after a dropped connection. A subscriber left behind per
    // reconnection would grow without bound for the life of the process.
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const stream = await openStream(controller.signal);
      await stream.readUntil((text) => text.includes(": connected"));
      expect(bus.subscriberCount).toBe(1);
      controller.abort();
      expect(await waitForSubscribers(0)).toBe(0);
    }
  });

  it("drops the subscription when the server closes the stream", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "a-1", role: "admin" } });
    const controller = new AbortController();
    const stream = await openStream(controller.signal);
    await stream.readUntil((text) => text.includes(": connected"));
    expect(bus.subscriberCount).toBe(1);

    // Server-side teardown (restart, idle timeout, proxy cut): the socket dies
    // without the client asking for it.
    app.server.closeAllConnections();

    expect(await waitForSubscribers(0)).toBe(0);
    controller.abort();
  });
});
