import { describe, expect, it, vi } from "vitest";
import {
  mutateUserAndRefreshSnapshots,
  refreshUserSessionSnapshots,
  type SessionSnapshotTransaction,
  type SessionSnapshotTransactionRunner,
} from "./session-snapshot.js";

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  id: "user-1",
  name: "User One",
  email: "user-1@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  twoFactorEnabled: false,
  role: "user",
  banned: false,
  banReason: null,
  banExpires: null,
  isMfaRequired: false,
  phone: null,
  firstName: null,
  lastName: null,
  username: null,
  company: null,
  position: null,
  address: null,
  postalCode: null,
  city: null,
  region: null,
  country: null,
  middleName: null,
  profileUrl: null,
  website: null,
  gender: null,
  birthdate: null,
  zoneinfo: null,
  locale: null,
  ...overrides,
});

function harness(reads: unknown[]) {
  const execute = vi.fn(async () => undefined);
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          const row = reads.shift();
          return row === undefined ? [] : [row];
        },
      }),
    }),
  }));
  const tx = { execute, select } as unknown as SessionSnapshotTransaction;
  const run: SessionSnapshotTransactionRunner = async (fn) => fn(tx);
  return { execute, run, tx };
}

describe("refreshUserSessionSnapshots", () => {
  it("publishes the selected user row without running user update hooks", async () => {
    const row = snapshot();
    const refreshUserSessions = vi.fn<(user: unknown) => Promise<void>>(
      async () => undefined,
    );
    const { execute, run } = harness([row]);

    await refreshUserSessionSnapshots({ refreshUserSessions }, "user-1", run);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(refreshUserSessions).toHaveBeenCalledWith(row);
  });

  it("fails with the user-not-found error when the row is gone", async () => {
    const refreshUserSessions = vi.fn<(user: unknown) => Promise<void>>(
      async () => undefined,
    );
    const { run } = harness([]);

    await expect(
      refreshUserSessionSnapshots({ refreshUserSessions }, "missing", run),
    ).rejects.toMatchObject({ code: "USR_001" });
    expect(refreshUserSessions).not.toHaveBeenCalled();
  });
});

describe("mutateUserAndRefreshSnapshots", () => {
  it("publishes the committed row inside the transaction", async () => {
    const updated = snapshot({ role: "admin" });
    const refreshUserSessions = vi.fn<(user: unknown) => Promise<void>>(
      async () => undefined,
    );
    const { run } = harness([updated]);

    await mutateUserAndRefreshSnapshots(
      { refreshUserSessions },
      "user-1",
      async () => undefined,
      run,
    );

    expect(refreshUserSessions).toHaveBeenCalledWith(updated);
  });

  it("reconciles the rolled-back row when the commit fails after publishing", async () => {
    const promoted = snapshot({ role: "admin" });
    const committed = snapshot({ role: "user" });
    const refreshUserSessions = vi.fn<(user: unknown) => Promise<void>>(
      async () => undefined,
    );
    const { tx } = harness([promoted, committed]);

    let commits = 0;
    const run: SessionSnapshotTransactionRunner = async (fn) => {
      commits += 1;
      const result = await fn(tx);
      if (commits === 1) throw new Error("commit failed");
      return result;
    };

    await expect(
      mutateUserAndRefreshSnapshots(
        { refreshUserSessions },
        "user-1",
        async () => undefined,
        run,
      ),
    ).rejects.toThrow("commit failed");

    expect(refreshUserSessions.mock.calls.map(([user]) => user)).toEqual([
      promoted,
      committed,
    ]);
  }, 10_000);
});
