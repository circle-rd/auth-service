import { ref } from 'vue';
import type { Ref } from 'vue';
import { USE_MOCK } from '@/api/client';

/**
 * Admin real-time channel (`GET /api/admin/events`, SSE).
 *
 * The stream is a signal, not a data feed: a frame names an event type and
 * carries at most the instant it happened, so a subscriber reacts by re-reading
 * the authoritative state through the REST endpoints it already calls.
 *
 * Authorization lives on the server (`requireAdmin` guards the route): a refused
 * subscription is treated as silence — no client-side gate, no retry loop, no
 * visible error. Reconnection is `EventSource`'s own behaviour.
 */

/** Single endpoint, same origin as the app; the session cookie authenticates it. */
const EVENTS_URL = '/api/admin/events';

/** Event types the channel may carry — mirrors `DOMAIN_EVENT_TYPES` server-side. */
export const ADMIN_EVENT_TYPES = ['login.recorded'] as const;

export type AdminEventType = (typeof ADMIN_EVENT_TYPES)[number];

export type AdminEventHandlers = Partial<Record<AdminEventType, () => void>>;

/**
 * Coalescing window. A burst of frames — a login spike — must become **one**
 * refresh, not one per login: the callers hit the database. Kept an order of
 * magnitude below the dashboard's 30 s poll, so an event still lands promptly
 * while a busy instance stays capped.
 */
export const DEFAULT_COALESCE_MS = 1_000;

export interface UseAdminEventsOptions {
  /** Coalescing window, in milliseconds. */
  coalesceMs?: number;
}

export interface AdminEventsHandle {
  /** Event type names received on this subscription. */
  readonly receivedTypes: Ref<readonly AdminEventType[]>;
  /** Release the subscription. */
  readonly close: () => void;
}

/**
 * Collapse a burst of triggers into a single call.
 *
 * The window is a **settle** window: every event restarts it, and the refresh
 * runs once the stream has been quiet for `windowMs`. A burst of N events
 * therefore costs exactly **one** round of requests — and because it runs after
 * the burst, that round already sees every login in it, which a refresh fired on
 * the first event of the burst could not.
 *
 * A settle window alone starves a stream that never falls quiet, so the wait is
 * capped at `windowMs` from the first event of the window: an uninterrupted
 * stream refreshes once per window instead of not at all.
 */
function createCoalescer(fire: () => void, windowMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Absolute instant the open window must fire by, however busy the stream is. */
  let deadline = 0;

  return {
    trigger(): void {
      const now = Date.now();
      if (timer === null) deadline = now + windowMs;
      const wait = Math.max(0, Math.min(windowMs, deadline - now));
      if (timer) clearTimeout(timer);
      // The cap can already have passed on a saturated stream; fire immediately
      // rather than compute a negative delay.
      timer = setTimeout(() => {
        timer = null;
        fire();
      }, wait);
    },
    dispose(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      deadline = 0;
    },
  };
}

export function useAdminEvents(
  handlers: AdminEventHandlers,
  options: UseAdminEventsOptions = {},
): AdminEventsHandle {
  const receivedTypes = ref<readonly AdminEventType[]>([]);
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;

  // Mock mode never talks to the API (see `@/api/client`), so it must not open
  // the stream either: the dashboard runs on mock data in development.
  if (USE_MOCK) {
    return { receivedTypes, close: () => {} };
  }

  const coalescers = ADMIN_EVENT_TYPES.filter((type) => handlers[type]).map(
    (type) => ({
      type,
      handler: createCoalescer(() => handlers[type]?.(), coalesceMs),
    }),
  );

  const source = new EventSource(EVENTS_URL);

  for (const { type, handler } of coalescers) {
    source.addEventListener(type, () => {
      if (!receivedTypes.value.includes(type)) {
        receivedTypes.value = [...receivedTypes.value, type];
      }
      handler.trigger();
    });
  }

  // A stream the server refuses (403 for a non-admin) or an interrupted one
  // surfaces as an error event. `EventSource` owns reconnection, so there is
  // nothing to do here — and nothing to log: the dashboard must not break, and
  // the 30 s poll keeps the counters converging on its own.
  source.onerror = () => {};

  return {
    receivedTypes,
    close: () => {
      for (const { handler } of coalescers) handler.dispose();
      source.close();
    },
  };
}
