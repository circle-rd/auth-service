import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { getRequestSession } from "../middleware.js";
import { ERR } from "../errors.js";
import { getEventBus, type DomainEvent } from "../services/event-bus.js";
import { deliveryFor, resolveAudience } from "../services/realtime-audience.js";

/**
 * Real-time channel (Server-Sent Events) for every authenticated session.
 *
 * The stream is a *signal*, not a data feed: a frame tells the client that
 * something changed, and the client re-fetches through the REST endpoints it
 * already calls. A frame carries the event name and the instant it happened,
 * never a user id, an e-mail, a room or a count.
 *
 * Which frames a connection receives is decided by `deliveryFor` from the
 * session's audience (see `realtime-audience.ts`). The client sends nothing.
 */

/** Comment frame that flushes the headers and lets the client see it is live. */
const CONNECTED_COMMENT = ": connected\n\n";

/** Idle comment so an intermediary does not close the stream. */
const KEEP_ALIVE_COMMENT = ": keep-alive\n\n";

const DEFAULT_KEEP_ALIVE_MS = 15_000;

/**
 * Longest life of one stream. A session whose rights were removed without a
 * closing event (a removed membership, an expired session) is bounded by this.
 */
const DEFAULT_MAX_STREAM_MS = 15 * 60_000;

export interface EventsRoutesOptions {
  /** Idle keep-alive period. Overridden by the test suite only. */
  keepAliveMs?: number;
  /** Maximum life of one stream. Overridden by the test suite only. */
  maxStreamMs?: number;
}

export async function eventsRoutes(
  fastify: FastifyInstance,
  opts: EventsRoutesOptions = {},
): Promise<void> {
  const keepAliveMs = opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const maxStreamMs = opts.maxStreamMs ?? DEFAULT_MAX_STREAM_MS;
  const openStreams = new Set<ServerResponse>();

  // Hijacked SSE responses are not tracked by Fastify's request lifecycle, so
  // `close()` would otherwise wait forever for a client connection that never
  // ends. End and destroy each live stream before Fastify starts waiting.
  fastify.addHook("preClose", async () => {
    for (const stream of openStreams) {
      if (!stream.writableEnded) stream.end();
      stream.destroy();
    }
    openStreams.clear();
  });

  // GET /api/events
  // Long-lived text/event-stream. The response is hijacked: Fastify is not
  // allowed to end or serialise it.
  fastify.get("/", async (req, reply) => {
    const session = await getRequestSession(req);
    if (!session) {
      return reply.status(401).send(ERR.AUTH_001().toJSON());
    }
    const role = (session.user as Record<string, unknown>).role as
      string | undefined;
    const audience = await resolveAudience(session.user.id, role);

    reply.hijack();
    const stream = reply.raw;
    openStreams.add(stream);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx buffers proxied responses by default, which would hold the
      // frames until the buffer fills.
      "x-accel-buffering": "no",
    });

    const write = (chunk: string) => {
      if (stream.writableEnded) return;
      stream.write(chunk);
    };

    const onEvent = (event: DomainEvent) => {
      const delivery = deliveryFor(event, audience);
      if (delivery.write) {
        // The event name is the whole message; the data field carries the
        // timestamp (the spec drops an event whose data buffer is empty).
        write(`event: ${event.type}\ndata: ${event.at}\n\n`);
      }
      if (delivery.close) {
        release();
        stream.end();
      }
    };

    const unsubscribe = getEventBus().subscribe(onEvent);
    const keepAlive = setInterval(() => write(KEEP_ALIVE_COMMENT), keepAliveMs);
    keepAlive.unref();
    const lifetime = setTimeout(() => {
      release();
      stream.end();
    }, maxStreamMs);
    lifetime.unref();

    // Every release path funnels here — `EventSource` reconnects on its own, so
    // a subscription left behind per reconnection would accumulate for the life
    // of the process. Idempotent: a closing event and the socket can both fire.
    let released = false;
    function release() {
      if (released) return;
      released = true;
      clearInterval(keepAlive);
      clearTimeout(lifetime);
      unsubscribe();
      openStreams.delete(stream);
    }
    req.raw.on("close", release);
    req.raw.on("error", release);

    write(CONNECTED_COMMENT);
    fastify.log.debug("[events] stream subscribed");
  });
}
