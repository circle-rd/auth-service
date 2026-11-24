import { describe, expect, it } from 'vitest';
import { coalesceRefresh } from './coalesceRefresh';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('coalesceRefresh', () => {
  it('runs once for a single call', async () => {
    let runs = 0;
    const refresh = coalesceRefresh(async () => {
      runs += 1;
    });
    await refresh();
    expect(runs).toBe(1);
  });

  it('replays once for calls made during a run, never more', async () => {
    let runs = 0;
    const gate = deferred();
    const refresh = coalesceRefresh(async () => {
      runs += 1;
      if (runs === 1) await gate.promise;
    });

    const first = refresh();
    const second = refresh();
    const third = refresh();
    gate.resolve();
    await Promise.all([first, second, third]);

    expect(runs).toBe(2);
  });

  it('lets every caller await the settled run', async () => {
    const gate = deferred();
    let settled = false;
    const refresh = coalesceRefresh(async () => {
      await gate.promise;
      settled = true;
    });

    const first = refresh();
    const second = refresh();
    gate.resolve();
    await second;
    expect(settled).toBe(true);
    await first;
  });

  it('starts a fresh run after the previous one settled', async () => {
    let runs = 0;
    const refresh = coalesceRefresh(async () => {
      runs += 1;
    });
    await refresh();
    await refresh();
    expect(runs).toBe(2);
  });
});
