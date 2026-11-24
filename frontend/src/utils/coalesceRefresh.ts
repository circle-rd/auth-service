/**
 * Wrap a refresh so that calls never overlap. A call made while a refresh runs
 * does not start a second one: it marks the state stale, and the running refresh
 * repeats once more before settling. Every caller awaits the same settled run.
 */
export function coalesceRefresh(refresh: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let stale = false;

  const drain = async (): Promise<void> => {
    do {
      stale = false;
      await refresh();
    } while (stale);
  };

  return () => {
    stale = true;
    running ??= drain().finally(() => {
      running = null;
    });
    return running;
  };
}
