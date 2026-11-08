import { describe, expect, it, vi } from "vitest";

const { deleteUserSessions, revokeUserRefreshTokens, deleteUserAccessTokens } =
  vi.hoisted(() => ({
    deleteUserSessions: vi.fn(),
    revokeUserRefreshTokens: vi.fn(),
    deleteUserAccessTokens: vi.fn(),
  }));

vi.mock("../auth.js", () => ({
  auth: {
    $context: Promise.resolve({
      internalAdapter: { deleteUserSessions },
    }),
  },
}));
vi.mock("./oauth-tokens.js", () => ({
  revokeUserRefreshTokens,
  deleteUserAccessTokens,
}));

import { revokeUserSessionsAndTokens } from "./session-revocation.js";

describe("revokeUserSessionsAndTokens", () => {
  it("revokes refresh tokens first and waits for session deletion before clearing access tokens", async () => {
    let resolveDelete!: () => void;
    deleteUserSessions.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );

    const operation = revokeUserSessionsAndTokens("user-1");
    await vi.waitFor(() =>
      expect(deleteUserSessions).toHaveBeenCalledWith("user-1"),
    );

    expect(revokeUserRefreshTokens).toHaveBeenCalledWith("user-1");
    expect(deleteUserAccessTokens).not.toHaveBeenCalled();

    resolveDelete();
    await operation;

    expect(deleteUserAccessTokens).toHaveBeenCalledWith("user-1");
  });
});
