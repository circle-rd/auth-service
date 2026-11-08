import { describe, expect, it, vi } from "vitest";

const { deleteUserSessions, revokeAllUserTokens } = vi.hoisted(() => ({
  deleteUserSessions: vi.fn(),
  revokeAllUserTokens: vi.fn(),
}));

vi.mock("../auth.js", () => ({
  auth: {
    $context: Promise.resolve({
      internalAdapter: { deleteUserSessions },
    }),
  },
}));
vi.mock("./oauth-tokens.js", () => ({ revokeAllUserTokens }));

import { revokeUserSessionsAndTokens } from "./session-revocation.js";

describe("revokeUserSessionsAndTokens", () => {
  it("deletes the sessions and then clears the OAuth tokens", async () => {
    await revokeUserSessionsAndTokens("user-1");

    expect(deleteUserSessions).toHaveBeenCalledWith("user-1");
    expect(revokeAllUserTokens).toHaveBeenCalledWith("user-1");
    expect(deleteUserSessions.mock.invocationCallOrder[0]).toBeLessThan(
      revokeAllUserTokens.mock.invocationCallOrder[0] ?? Infinity,
    );
  });
});
