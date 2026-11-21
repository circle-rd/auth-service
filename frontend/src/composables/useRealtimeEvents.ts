import { USE_MOCK } from '@/api/client';

/**
 * Real-time channel (`GET /api/events`, SSE) shared by every signed-in session.
 *
 * The stream is a signal, not a data feed: a frame names an event type and
 * carries at most the instant it happened, so a subscriber reacts by re-reading
 * the authoritative state through the REST endpoints it already calls. Which
 * frames arrive is decided by the server from the session's rooms — a user
 * never hears about another user, and a non-admin never hears administration
 * events — so a handler is only ever called for an event the session may see.
 *
 * Reconnection is `EventSource`'s own behaviour. A reconnect may follow a lost
 * or closed stream, and events emitted in between are gone: `onResync` lets the
 * caller re-read once, which replaces any periodic polling.
 */

/** Single endpoint, same origin as the app; the session cookie authenticates it. */
const EVENTS_URL = '/api/events';

/** Every event type the channel may carry to a session (mirrors `DOMAIN_EVENT_TYPES`). */
export const REALTIME_EVENT_TYPES = [
  'login.recorded',
  'presence.changed',
  'session.created',
  'session.revoked',
  'user.changed',
  'application.changed',
  'organization.changed',
  'wallet.changed',
  'subscription.changed',
  'resource.changed',
  'catalogue.changed',
] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

export type RealtimeEventHandlers = Partial<Record<RealtimeEventType, () => void>>;

/**
 * Coalescing window. A burst of frames — a login spike — must become **one**
 * refresh, not one per login: the callers hit the database. Kept an order of
 * magnitude below the old polling cadence, so an event still lands promptly
 * while a busy instance stays capped.
 */
const DEFAULT_COALESCE_MS = 1_000;

export interface UseRealtimeEventsOptions {
  /** Coalescing window, in milliseconds. */
  coalesceMs?: number;
  /** Called after each reconnection: events emitted while disconnected are lost, so re-read once. */
  onResync?: () => void;
}

export interface RealtimeEventsHandle {
  /** Release the subscription. */
  readonly close: () => void;
}

/**
 * Collapse a burst into one call. The first event of a burst opens a window and
 * the call runs when it closes, so it sees every change that arrived inside it:
 * a burst costs one round of requests, and never more than one per window.
 */
function createCoalescer(fire: () => void, windowMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    trigger(): void {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        fire();
      }, windowMs);
    },
    dispose(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export function useRealtimeEvents(
  handlers: RealtimeEventHandlers,
  options: UseRealtimeEventsOptions = {},
): RealtimeEventsHandle {
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;

  // Mock mode never talks to the API (see `@/api/client`), so it must not open
  // the stream either: the dashboard runs on mock data in development.
  if (USE_MOCK) {
    return { close: () => {} };
  }

  const coalescers = REALTIME_EVENT_TYPES.filter((type) => handlers[type]).map(
    (type) => ({
      type,
      handler: createCoalescer(() => handlers[type]?.(), coalesceMs),
    }),
  );

  const source = new EventSource(EVENTS_URL);

  for (const { type, handler } of coalescers) {
    source.addEventListener(type, () => handler.trigger());
  }

  // The first open is the subscription itself; the page has just read its
  // state. Every later open follows a reconnection, which may have lost frames.
  let opened = false;
  source.onopen = () => {
    if (opened) options.onResync?.();
    opened = true;
  };

  // A stream the server refuses (401 once signed out) or an interrupted one
  // surfaces as an error event. `EventSource` owns reconnection, so there is
  // nothing to do here — and nothing to log: the page must not break.
  source.onerror = () => {};

  return {
    close: () => {
      for (const { handler } of coalescers) handler.dispose();
      source.close();
    },
  };
}
