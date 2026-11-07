/**
 * Serialise the MFA mutations that read a user's factors before another
 * component changes them. BetterAuth owns the delete/enable steps, so the
 * guard and the mutation cannot share a database transaction; an in-process
 * lock spans both. The timeout prevents a lost `after` hook from wedging a
 * user forever.
 */
const LOCK_TIMEOUT_MS = 15_000;
const tails = new Map<string, Promise<void>>();
const releases = new Map<string, () => void>();

export async function acquireUserLock(userId: string): Promise<() => void> {
  const previous = tails.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(
    userId,
    previous.then(() => current),
  );
  await previous;

  const timer = setTimeout(() => release(), LOCK_TIMEOUT_MS);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
    release();
    if (releases.get(userId) === release) {
      releases.delete(userId);
      tails.delete(userId);
    }
  };
}

/** Acquire and remember the release function for a before/after hook pair. */
export async function holdUserLock(userId: string): Promise<void> {
  const release = await acquireUserLock(userId);
  releases.set(userId, release);
}

export function releaseUserLock(userId: string): void {
  releases.get(userId)?.();
  releases.delete(userId);
}
