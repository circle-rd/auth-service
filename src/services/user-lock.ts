/**
 * Serialise the MFA mutations that read a user's factors before another
 * component changes them. BetterAuth owns the delete/enable steps, so the
 * guard and the mutation cannot share a database transaction; an in-process
 * lock spans both. The timeout prevents a lost `after` hook from wedging a
 * user forever, while each acquisition keeps its own release function so a
 * timed-out holder can never release a newer caller's lock.
 */
const LOCK_TIMEOUT_MS = 15_000;
const tails = new Map<string, Promise<void>>();

/** Carries a before-hook acquisition to the matching after hook. */
export const USER_LOCK = Symbol("userLock");

type LockCarrier = { [USER_LOCK]?: () => void };

export async function acquireUserLock(userId: string): Promise<() => void> {
  const previous = tails.get(userId) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const tail = previous.then(() => current);
  tails.set(userId, tail);
  await previous;

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    resolveCurrent();
    // Only the acquisition that owns the current tail may remove it; a queued
    // caller has already replaced the entry by the time it runs.
    if (tails.get(userId) === tail) tails.delete(userId);
  };

  const timer = setTimeout(release, LOCK_TIMEOUT_MS);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
    release();
  };
}

/** Acquire and attach the release function to this request's hook context. */
export async function holdUserLock(ctx: object, userId: string): Promise<void> {
  const carrier = ctx as LockCarrier;
  carrier[USER_LOCK] = await acquireUserLock(userId);
}

/** Release only the acquisition attached to this exact hook context. */
export function releaseUserLock(ctx: object): void {
  const carrier = ctx as LockCarrier;
  carrier[USER_LOCK]?.();
  delete carrier[USER_LOCK];
}
