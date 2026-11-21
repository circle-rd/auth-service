import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn() }));
vi.mock("../event-bus.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publishEvent: mockPublish,
}));

const user = { ownerType: "user", ownerId: "user-a" };
const org = { ownerType: "org", ownerId: "org-1" };

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
  it("publishes the first change at once to the admin room and the owner", async () => {
    const notify = await loadNotifier();
    notify(user);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith("wallet.changed", [
      "admin",
      "user:user-a",
    ]);
  });

  it("addresses an organization wallet to its org room", async () => {
    const notify = await loadNotifier();
    notify(org);
    expect(mockPublish).toHaveBeenCalledWith("wallet.changed", [
      "admin",
      "org:org-1",
    ]);
  });

  it("collapses a burst into one immediate and one trailing event", async () => {
    const notify = await loadNotifier();
    for (let i = 0; i < 50; i += 1) notify(user);
    expect(mockPublish).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(mockPublish).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(10_000);
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it("addresses the trailing event to every owner touched in the burst", async () => {
    const notify = await loadNotifier();
    notify(user);
    notify(org);
    notify({ ownerType: "user", ownerId: "user-b" });
    vi.advanceTimersByTime(1_000);
    expect(mockPublish).toHaveBeenLastCalledWith("wallet.changed", [
      "admin",
      "org:org-1",
      "user:user-b",
    ]);
  });

  it("refuses an unknown owner type", async () => {
    const notify = await loadNotifier();
    expect(() => notify({ ownerType: "robot", ownerId: "x" })).toThrow(
      "unknown wallet owner type",
    );
  });

  it("publishes again once the quiet period has passed", async () => {
    const notify = await loadNotifier();
    notify(user);
    vi.advanceTimersByTime(1_500);
    notify(user);
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it("spaces the trailing event from the last one", async () => {
    const notify = await loadNotifier();
    notify(user);
    vi.advanceTimersByTime(400);
    notify(user);
    vi.advanceTimersByTime(599);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });
});
