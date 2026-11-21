import {
  ADMIN_ROOM,
  orgRoom,
  publishEvent,
  userRoom,
  type Room,
} from "../event-bus.js";

/** Shortest delay between two `wallet.changed` events. */
const MIN_INTERVAL_MS = 1_000;

let lastPublishedAt = 0;
let pending: NodeJS.Timeout | null = null;
/** Owners touched since the last frame; a coalesced frame addresses all of them. */
const pendingRooms = new Set<Room>();

/** The wallet owner as stored on `wallet_accounts`. */
export interface WalletOwner {
  ownerType: string;
  ownerId: string;
}

function ownerRoom(owner: WalletOwner): Room {
  if (owner.ownerType === "user") return userRoom(owner.ownerId);
  if (owner.ownerType === "org") return orgRoom(owner.ownerId);
  throw new Error(`unknown wallet owner type: ${owner.ownerType}`);
}

function publish(): void {
  lastPublishedAt = Date.now();
  const rooms: [Room, ...Room[]] = [ADMIN_ROOM, ...pendingRooms];
  pendingRooms.clear();
  publishEvent("wallet.changed", rooms);
}

/**
 * Tell the owner of a wallet, and the admin dashboard, that it changed. Every
 * LLM call debits a wallet, so events are coalesced: the first one goes out at
 * once, the others within the next second collapse into a single trailing one
 * that addresses every owner touched in between.
 */
export function notifyWalletChanged(owner: WalletOwner): void {
  pendingRooms.add(ownerRoom(owner));
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
