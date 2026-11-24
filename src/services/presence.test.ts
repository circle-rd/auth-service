import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { state, publishEvent } = vi.hoisted(() => ({
  state: { counts: [] as number[] },
  publishEvent: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ count: state.counts.shift() ?? 0 }]),
      }),
    }),
  },
}));

vi.mock("./event-bus.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publishEvent,
}));

import { startPresenceWatcher } from "./presence.js";

beforeEach(() => {
  vi.useFakeTimers();
  state.counts = [];
  publishEvent.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startPresenceWatcher", () => {
  it("announces only a change of the online count, to the admin room", async () => {
    state.counts = [2, 2, 3, 3];
    const stop = startPresenceWatcher(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(publishEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(publishEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent).toHaveBeenCalledWith("presence.changed", ["admin"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops counting once stopped", async () => {
    state.counts = [1, 2, 3];
    const stop = startPresenceWatcher(1_000);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publishEvent).not.toHaveBeenCalled();
    expect(state.counts).toHaveLength(2);
  });
});
