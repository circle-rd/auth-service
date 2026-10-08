/**
 * Domain-event bus behind the admin real-time channel.
 *
 * An event carries a type name and the instant it was published — never a
 * payload, never an identifier. Subscribers are the admin SSE connections; the
 * dashboard re-fetches whatever it needs through the REST endpoints it already
 * calls.
 *
 * The default is an in-process bus (single instance). When `REDIS_URL` is set,
 * `createEventBus` lazily loads `ioredis` and fans out over a pub/sub channel so
 * an event published on one instance reaches subscribers connected to another,
 * while a message this instance published is not delivered a second time.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logger } from "../logger.js";

/**
 * The closed set of event types the channel may carry.
 *
 * Every type is a name and nothing else. A type that would need a payload to be
 * useful is a type that is wrong — the fix for it is a better type, never a
 * wider frame (see `src/routes/admin/events.ts`).
 */
export const DOMAIN_EVENT_TYPES = [
  "login.recorded",
  "session.created",
  "session.revoked",
  "user.changed",
  "application.changed",
  "organization.changed",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** Something worth telling the dashboard about: a type and a timestamp. */
export interface DomainEvent {
  type: DomainEventType;
  at: string;
}

export type EventSubscriber = (event: DomainEvent) => void;

export interface EventBus {
  publish(type: DomainEventType): void;
  subscribe(subscriber: EventSubscriber): () => void;
  /** Live subscriber count — the observable side of the leak guarantee. */
  readonly subscriberCount: number;
  readonly name: string;
  close(): Promise<void>;
}

/** Redis pub/sub channel carrying the fan-out. */
const REDIS_CHANNEL = "auth-service.events";

/** Envelope published to Redis; `origin` lets an instance drop its own echo. */
const remoteEventSchema = z.object({
  origin: z.string(),
  type: z.enum(DOMAIN_EVENT_TYPES),
  at: z.string().datetime(),
});

function createEvent(type: DomainEventType): DomainEvent {
  return { type, at: new Date().toISOString() };
}

/** Shared subscriber bookkeeping for every bus implementation. */
abstract class BaseEventBus implements EventBus {
  abstract readonly name: string;

  private readonly subscribers = new Set<EventSubscriber>();

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  abstract publish(type: DomainEventType): void;

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  async close(): Promise<void> {
    this.subscribers.clear();
  }

  /**
   * Deliver to every subscriber. A subscriber that throws — a dead socket, a
   * writer that failed — must not stop the others and must never reach the
   * publisher, which runs inside the login path.
   */
  protected dispatch(event: DomainEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        logger.warn({ err: String(err) }, "[events] subscriber failed");
      }
    }
  }
}

export class MemoryEventBus extends BaseEventBus {
  readonly name = "memory";

  publish(type: DomainEventType): void {
    this.dispatch(createEvent(type));
  }
}

/** Minimal subset of the ioredis client the bus relies on. */
interface RedisLike {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  on(
    event: "message",
    handler: (channel: string, message: string) => void,
  ): unknown;
  quit(): Promise<unknown>;
}

export class RedisEventBus extends BaseEventBus {
  readonly name = "redis";

  private readonly origin = randomUUID();

  constructor(private readonly client: RedisLike) {
    super();
    this.client.on("message", (channel, message) => {
      if (channel !== REDIS_CHANNEL) return;
      const event = parseRemoteEvent(message, this.origin);
      if (event) this.dispatch(event);
    });
  }

  /** Join the fan-out channel. Kept out of the constructor so the socket is
   * only opened by the caller that owns the bus lifecycle. */
  async start(): Promise<void> {
    await this.client.subscribe(REDIS_CHANNEL);
  }

  publish(type: DomainEventType): void {
    const event = createEvent(type);
    // Local subscribers are served first: a Redis outage must not silence the
    // dashboard of the instance the login happened on.
    this.dispatch(event);
    void this.client
      .publish(REDIS_CHANNEL, JSON.stringify({ origin: this.origin, ...event }))
      .catch((err: unknown) => {
        logger.warn({ err: String(err) }, "[events] redis publish failed");
      });
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => {});
    await super.close();
  }
}

/**
 * Parse a fan-out message. Anything malformed, or published by this very
 * instance, is dropped rather than delivered.
 */
function parseRemoteEvent(message: string, origin: string): DomainEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return null;
  }
  const parsed = remoteEventSchema.safeParse(raw);
  if (!parsed.success || parsed.data.origin === origin) return null;
  return { type: parsed.data.type, at: parsed.data.at };
}

export async function createEventBus(redisUrl?: string): Promise<EventBus> {
  if (!redisUrl) return new MemoryEventBus();

  // Non-literal specifier so TypeScript does not require ioredis to be
  // installed for the default build.
  const specifier = "ioredis";
  let mod: {
    default: new (url: string, options?: Record<string, unknown>) => RedisLike;
  };
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch {
    throw new Error(
      "REDIS_URL is set but the optional 'ioredis' package is not installed. " +
        "Run `pnpm add ioredis` or unset REDIS_URL.",
    );
  }
  const client = new mod.default(redisUrl, { maxRetriesPerRequest: 1 });
  const bus = new RedisEventBus(client);
  await bus.start();
  return bus;
}

// ── Application seam ─────────────────────────────────────────────────────────
// Mirrors the mail transport: a memoised default that the server replaces with
// the bus it owns at boot, so `recordLogin()` publishes without importing the
// server graph.

let active: EventBus | null = null;

/** The bus every publisher goes through. */
export function getEventBus(): EventBus {
  if (!active) active = new MemoryEventBus();
  return active;
}

/** Install the active bus. Passing `null` restores the in-process default. */
export function setEventBus(bus: EventBus | null): void {
  active = bus;
}

/**
 * Publish a domain event. Non-fatal by construction: the emit happens inside
 * the login path, so a failing bus must never fail the login. A lost event is
 * not an error either — the dashboard's 30 s poll remains the safety net.
 */
export function publishEvent(type: DomainEventType): void {
  try {
    getEventBus().publish(type);
  } catch (err) {
    logger.warn({ err: String(err) }, "[events] failed to publish event");
  }
}