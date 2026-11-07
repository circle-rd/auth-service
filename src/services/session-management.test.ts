import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLimit } = vi.hoisted(() => ({ mockLimit: vi.fn() }));

vi.mock("../db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mockLimit,
        }),
      }),
    }),
  },
}));

import {
  appendSessionState,
  checkSessionIframeHtml,
  checkSessionState,
  createSessionState,
} from "./session-management.js";

const CLIENT_ID = "client-1";
const ORIGIN = "https://rp.example";

describe("session management", () => {
  beforeEach(() => {
    mockLimit.mockReset();
  });

  it("reports an active session as unchanged", async () => {
    mockLimit.mockResolvedValue([{ expiresAt: new Date(Date.now() + 60_000) }]);
    const state = createSessionState("session-1", CLIENT_ID, ORIGIN);

    await expect(checkSessionState(CLIENT_ID, ORIGIN, state)).resolves.toBe(
      "unchanged",
    );
  });

  it("reports a missing or expired session as changed", async () => {
    const state = createSessionState("session-1", CLIENT_ID, ORIGIN);
    mockLimit.mockResolvedValueOnce([]);
    await expect(checkSessionState(CLIENT_ID, ORIGIN, state)).resolves.toBe(
      "changed",
    );

    mockLimit.mockResolvedValueOnce([{ expiresAt: new Date(Date.now() - 1) }]);
    await expect(checkSessionState(CLIENT_ID, ORIGIN, state)).resolves.toBe(
      "changed",
    );
  });

  it("rejects a state bound to another client or origin", async () => {
    const state = createSessionState("session-1", CLIENT_ID, ORIGIN);

    await expect(checkSessionState("client-2", ORIGIN, state)).resolves.toBe(
      "error",
    );
    await expect(
      checkSessionState(CLIENT_ID, "https://other.example", state),
    ).resolves.toBe("error");
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it("rejects a tampered state", async () => {
    const state = createSessionState("session-1", CLIENT_ID, ORIGIN);
    const tampered = `${state.slice(0, -1)}x`;

    await expect(checkSessionState(CLIENT_ID, ORIGIN, tampered)).resolves.toBe(
      "error",
    );
    await expect(
      checkSessionState(CLIENT_ID, ORIGIN, "not-a-state"),
    ).resolves.toBe("error");
  });
});

describe("appendSessionState", () => {
  it("adds session_state to an authorization code redirect", () => {
    const result = appendSessionState(
      "https://rp.example/cb?code=abc&state=xyz",
      "opaque",
    );
    const url = new URL(result);
    expect(url.searchParams.get("code")).toBe("abc");
    expect(url.searchParams.get("session_state")).toBe("opaque");
  });

  it("adds session_state to an error redirect", () => {
    const result = appendSessionState(
      "https://rp.example/cb?error=invalid_request",
      "opaque",
    );
    expect(new URL(result).searchParams.get("session_state")).toBe("opaque");
  });

  it("leaves non-authorization redirects untouched", () => {
    const location = "https://auth.example/login?next=%2F";
    expect(appendSessionState(location, "opaque")).toBe(location);
    expect(appendSessionState("not a url", "opaque")).toBe("not a url");
  });
});

describe("checkSessionIframeHtml", () => {
  it("serves a frameable script that calls the state endpoint", () => {
    const html = checkSessionIframeHtml();
    expect(html).toContain("/check_session_state");
    expect(html).toContain("postMessage");
    expect(html).toContain("session_state");
  });
});
