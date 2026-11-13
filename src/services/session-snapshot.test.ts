import { describe, expect, it, vi } from "vitest";
import { refreshUserSessionSnapshots } from "./session-snapshot.js";

const user = {
  id: "user-1",
  name: "User One",
  email: "user-1@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("refreshUserSessionSnapshots", () => {
  it("refreshes live session copies without running user update hooks", async () => {
    const findUserById = vi.fn(async () => user);
    const refreshUserSessions = vi.fn(async () => undefined);

    await refreshUserSessionSnapshots(
      { findUserById, refreshUserSessions },
      "user-1",
    );

    expect(findUserById).toHaveBeenCalledWith("user-1");
    expect(refreshUserSessions).toHaveBeenCalledWith(user);
  });

  it("fails when the user no longer exists", async () => {
    const refreshUserSessions = vi.fn(async () => undefined);

    await expect(
      refreshUserSessionSnapshots(
        { findUserById: async () => null, refreshUserSessions },
        "missing",
      ),
    ).rejects.toThrow(/missing user/);
    expect(refreshUserSessions).not.toHaveBeenCalled();
  });
});
