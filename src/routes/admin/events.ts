import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../middleware.js";
import { getEventBus, type DomainEvent } from "../../services/event-bus.js";

/**
 * Admin real-time channel (Server-Sent Events).
 *
 * The stream is a *signal*, not a data feed: a frame tells the dashboard that
 * something changed, and the client re-fetches through the REST endpoints it
 * already calls. A frame therefore carries the event name and, at most, the
 * instant it happened — never a user id, an e-mail or a count.
 *
 * Guarded by `requireAdmin` like every other `/api/admin/*` route, so a
 * standard user (the `/profile` page, for instance) can never subscribe.
 */

/** Comment frame that flushes the headers and lets the client see it is live. */
const CONNECTED_COMMENT = ": connected\n\n";

/** Idle comment so an intermediary does not close the stream. */
const KEEP_ALIVE_COMMENT = ": keep-alive\n\n";

const DEFAULT_KEEP_ALIVE_MS = 15_000;

export interface EventsRoutesOptions {
  /** Idle keep-alive period. Overridden by the test suite only. */
  keepAliveMs?: number;
}

export async function eventsRoutes(
  fastify: FastifyInstance,
  opts: EventsRoutesOptions = {},
): Promise<void> {
  fastify.addHook("preHandler", requireAdmin);

  const keepAliveMs = opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;

  // GET /api/admin/events
  // Long-lived text/event-stream. The response is hijacked: Fastify is not
  // allowed to end or serialise it, and nothing here touches the database.
  fastify.get("/", async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx buffers proxied responses by default, which would hold the
      // frames until the buffer fills.
      "x-accel-buffering": "no",
    });

    const write = (chunk: string) => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(chunk);
    };

    const onEvent = (event: DomainEvent) => {
      // The event name is the whole message; the data field carries the
      // timestamp (the spec drops an event whose data buffer is empty).
      write(`event: ${event.type}\ndata: ${event.at}\n\n`);
    };

    const unsubscribe = getEventBus().subscribe(onEvent);
    const keepAlive = setInterval(() => write(KEEP_ALIVE_COMMENT), keepAliveMs);
    keepAlive.unref();

    // Every subscriber release path funnels here — `EventSource` reconnects on
    // its own, so a subscription left behind per reconnection would accumulate
    // for the life of the process.
    const release = () => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    req.raw.on("close", release);
    req.raw.on("error", release);

    write(CONNECTED_COMMENT);
    fastify.log.debug("[events] admin stream subscribed");
  });
}
