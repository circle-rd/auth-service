import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn() }));
vi.mock("../event-bus.js", () => ({ publishEvent: mockPublish }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  mockPublish.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

async function loadNotifier() {
  return (await import("./events.js")).notifyWalletChanged;
}

describe("notifyWalletChanged", () => {
  it("publishes the first change at once", async () => {
    const notify = await loadNotifier();
    notify();
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith("wallet.changed");
  });

  it("collapses a burst into one immediate and one trailing event", async () => {
    const notify = await loadNotifier();
    for (let i = 0; i < 50; i += 1) notify();
    expect(mockPublish).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(mockPublish).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(10_000);
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it("publishes again once the quiet period has passed", async () => {
    const notify = await loadNotifier();
    notify();
    vi.advanceTimersByTime(1_500);
    notify();
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it("spaces the trailing event from the last one", async () => {
    const notify = await loadNotifier();
    notify();
    vi.advanceTimersByTime(400);
    notify();
    vi.advanceTimersByTime(599);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });
});
