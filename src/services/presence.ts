import { countDistinct, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { session as sessionTable } from "../db/auth-schema.js";
import { logger } from "../logger.js";
import { ADMIN_ROOM, publishEvent } from "./event-bus.js";

/** Distinct users with at least one non-expired session — i.e. currently online. */
export async function countOnlineUsers(): Promise<number> {
  const [{ count }] = await db
    .select({ count: countDistinct(sessionTable.userId) })
    .from(sessionTable)
    .where(gt(sessionTable.expiresAt, new Date()));
  return count;
}

/**
 * Sessions expire without any write, so nothing else announces that the online
 * count dropped. This timer re-counts on a fixed cadence and announces only a
 * change, to the admin room. It is the single server-side clock behind the
 * dashboard's online counter.
 */
export function startPresenceWatcher(intervalMs: number): () => void {
  let last: number | null = null;

  const tick = () => {
    countOnlineUsers()
      .then((count) => {
        if (last !== null && count !== last) {
          publishEvent("presence.changed", [ADMIN_ROOM]);
        }
        last = count;
      })
      .catch((err: unknown) => {
        logger.warn({ err: String(err) }, "[presence] count failed");
      });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
