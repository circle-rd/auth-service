import { describe, it, expect, vi, beforeEach } from "vitest";

const insertValuesMock = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
const updateSetMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock("../db/index.js", () => {
  return {
    db: {
      insert: vi.fn(() => ({ values: insertValuesMock })),
      update: vi.fn(() => ({
        set: updateSetMock.mockImplementation(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
    },
  };
});

import { recordLogin } from "./login-history.js";

describe("recordLogin", () => {
  beforeEach(() => {
    insertValuesMock.mockClear();
    updateSetMock.mockClear();
  });

  it("inserts a login_history row with the provided context", async () => {
    const loggedAt = new Date("2026-05-17T12:00:00Z");
    await recordLogin({
      userId: "user-1",
      applicationId: "app-1",
      sessionId: "sess-1",
      ipAddress: "10.0.0.1",
      userAgent: "Mozilla/5.0",
      loggedAt,
    });

    expect(insertValuesMock).toHaveBeenCalledWith({
      userId: "user-1",
      applicationId: "app-1",
      sessionId: "sess-1",
      ipAddress: "10.0.0.1",
      userAgent: "Mozilla/5.0",
      loggedAt,
    });
  });

  it("normalises missing optional fields to null", async () => {
    await recordLogin({ userId: "user-2" });
    const call = (insertValuesMock.mock.calls[0]?.[0] ?? {}) as Record<
      string,
      unknown
    >;
    expect(call.applicationId).toBeNull();
    expect(call.sessionId).toBeNull();
    expect(call.ipAddress).toBeNull();
    expect(call.userAgent).toBeNull();
    expect(call.loggedAt).toBeInstanceOf(Date);
  });

  it("updates user.lastLoginAt with the same timestamp", async () => {
    const loggedAt = new Date("2026-05-17T13:30:00Z");
    await recordLogin({ userId: "user-3", loggedAt });
    expect(updateSetMock).toHaveBeenCalledWith({ lastLoginAt: loggedAt });
  });
});
