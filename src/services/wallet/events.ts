import { publishEvent } from "../event-bus.js";

/** Shortest delay between two `wallet.changed` events. */
const MIN_INTERVAL_MS = 1_000;

let lastPublishedAt = 0;
let pending: NodeJS.Timeout | null = null;

function publish(): void {
  lastPublishedAt = Date.now();
  publishEvent("wallet.changed");
}

/**
 * Tell the admin dashboard that a wallet changed. Every LLM call debits a
 * wallet, so events are coalesced: the first one goes out at once, the others
 * within the next second collapse into a single trailing one.
 */
export function notifyWalletChanged(): void {
  const elapsed = Date.now() - lastPublishedAt;
  if (elapsed >= MIN_INTERVAL_MS) {
    publish();
    return;
  }
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    publish();
  }, MIN_INTERVAL_MS - elapsed);
  pending.unref();
}
