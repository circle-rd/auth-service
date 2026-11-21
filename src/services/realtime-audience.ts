import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { member } from "../db/auth-schema.js";
import { userApplications } from "../db/schema.js";
import {
  ADMIN_ROOM,
  appRoom,
  CLOSING_EVENT_TYPES,
  orgRoom,
  USER_EVENT_TYPES,
  userRoom,
  type DomainEvent,
  type Room,
} from "./event-bus.js";
import { ADMIN_ROLES, hasAnyRole } from "./roles.js";

/**
 * What one real-time connection may hear, fixed when the stream opens.
 *
 * Built only from the authenticated session and the database, never from
 * anything the client sends. The stream is re-resolved on every reconnect, so
 * a membership or role change takes effect once the stream closes.
 */
export interface Audience {
  readonly rooms: ReadonlySet<Room>;
  readonly admin: boolean;
}

/**
 * What one event does for one connection. A closing event may still carry a
 * frame: an administrator who changes their own membership hears about it, and
 * their stream then ends so the new audience is resolved on reconnection.
 */
export interface Delivery {
  readonly write: boolean;
  readonly close: boolean;
}

const SKIP: Delivery = { write: false, close: false };

/** Rooms of a session: its own user, its organizations and its active applications. */
export async function resolveAudience(
  userId: string,
  role: string | null | undefined,
): Promise<Audience> {
  const [orgs, apps] = await Promise.all([
    db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId)),
    db
      .select({ applicationId: userApplications.applicationId })
      .from(userApplications)
      .where(
        and(
          eq(userApplications.userId, userId),
          eq(userApplications.isActive, true),
        ),
      ),
  ]);

  const admin = hasAnyRole(role, ADMIN_ROLES);
  const rooms = new Set<Room>([userRoom(userId)]);
  if (admin) rooms.add(ADMIN_ROOM);
  for (const row of orgs) rooms.add(orgRoom(row.organizationId));
  for (const row of apps) rooms.add(appRoom(row.applicationId));
  return { rooms, admin };
}

/**
 * Decide what an event does for one connection.
 *
 * - Nothing when the event is addressed to no room of the connection.
 * - `close` when a closing type reached a room other than the admin room: the
 *   session re-authenticates on reconnection.
 * - `write` for an administrator on any type, and for a standard user only on
 *   the user types. A standard user never receives administration data, even
 *   when an event is addressed to one of its rooms.
 */
export function deliveryFor(event: DomainEvent, audience: Audience): Delivery {
  const matched = event.rooms.filter((room) => audience.rooms.has(room));
  if (matched.length === 0) return SKIP;
  const close =
    CLOSING_EVENT_TYPES.includes(event.type) &&
    matched.some((room) => room !== ADMIN_ROOM);
  const write = audience.admin || USER_EVENT_TYPES.includes(event.type);
  return { write, close };
}
