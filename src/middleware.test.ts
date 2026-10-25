import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

const { mockGetSession, mockVerify } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockVerify: vi.fn(),
}));

vi.mock("better-auth/node", () => ({
  fromNodeHeaders: vi.fn((headers: unknown) => headers),
}));
vi.mock("./auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));
vi.mock("./services/oauth-tokens.js", () => ({
  verifyBearerAccessToken: mockVerify,
}));

const { requireUserOrBearer } = await import("./middleware.js");

function requestWithAuthorization(authorization?: string): FastifyRequest {
  return {
    headers: authorization ? { authorization } : {},
  } as FastifyRequest;
}

function replyCapture(): {
  reply: FastifyReply;
  statusCode: number | null;
  payload: unknown;
} {
  const state = {
    statusCode: null as number | null,
    payload: undefined as unknown,
  };
  const reply = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    async send(payload: unknown) {
      state.payload = payload;
      return this;
    },
  } as unknown as FastifyReply;
  return {
    reply,
    get statusCode() {
      return state.statusCode;
    },
    get payload() {
      return state.payload;
    },
  };
}

beforeEach(() => {
  mockGetSession.mockReset().mockResolvedValue({
    user: { id: "session-user" },
  });
  mockVerify.mockReset().mockResolvedValue(null);
});

describe("requireUserOrBearer", () => {
  it("accepts a session when no bearer token is present", async () => {
    const capture = replyCapture();
    await expect(
      requireUserOrBearer(
        requestWithAuthorization(),
        capture.reply,
        "wallet:self:read",
      ),
    ).resolves.toBe("session-user");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("accepts a user-bound bearer token for the auth-service audience", async () => {
    mockVerify.mockResolvedValue({
      clientId: "reverse-box",
      userId: "bearer-user",
      audiences: [config.betterAuth.url],
      scopes: ["wallet:self:read"],
    });

    const capture = replyCapture();
    await expect(
      requireUserOrBearer(
        requestWithAuthorization("Bearer token"),
        capture.reply,
        "wallet:self:read",
      ),
    ).resolves.toBe("bearer-user");
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("rejects a bearer token minted for another audience", async () => {
    mockVerify.mockResolvedValue({
      clientId: "reverse-box",
      userId: "bearer-user",
      audiences: ["https://llm.example.com"],
      scopes: ["wallet:self:read"],
    });

    const capture = replyCapture();
    await expect(
      requireUserOrBearer(
        requestWithAuthorization("Bearer token"),
        capture.reply,
        "wallet:self:read",
      ),
    ).resolves.toBe("");
    expect(capture.statusCode).toBe(403);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("rejects a bearer token without the required scope", async () => {
    mockVerify.mockResolvedValue({
      clientId: "reverse-box",
      userId: "bearer-user",
      audiences: [config.betterAuth.url],
      scopes: ["openid"],
    });

    const capture = replyCapture();
    await expect(
      requireUserOrBearer(
        requestWithAuthorization("Bearer token"),
        capture.reply,
        "wallet:self:read",
      ),
    ).resolves.toBe("");
    expect(capture.statusCode).toBe(403);
  });

  it("rejects a client_credentials token", async () => {
    mockVerify.mockResolvedValue({
      clientId: "reverse-box",
      userId: null,
      audiences: [config.betterAuth.url],
      scopes: ["wallet:self:read"],
    });

    const capture = replyCapture();
    await expect(
      requireUserOrBearer(
        requestWithAuthorization("Bearer token"),
        capture.reply,
        "wallet:self:read",
      ),
    ).resolves.toBe("");
    expect(capture.statusCode).toBe(403);
  });

  it("does not fall back to the session when a bearer token is invalid", async () => {
    const capture = replyCapture();
    await expect(
      requireUserOrBearer(
        requestWithAuthorization("Bearer broken"),
        capture.reply,
        "wallet:self:read",
      ),
    ).resolves.toBe("");
    expect(capture.statusCode).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});
