import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors.js";

const { mockDb, mockVerify, state } = vi.hoisted(() => {
  const state = { client: [] as unknown[] };
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(state.client),
  };
  return {
    mockDb: { select: () => chain },
    mockVerify: vi.fn(),
    state,
  };
});

vi.mock("../db/index.js", () => ({ db: mockDb }));
vi.mock("./oauth-tokens.js", () => ({ verifyBearerAccessToken: mockVerify }));

const { requireMachineScope } = await import("./machine-auth.js");

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const verified = (overrides: Record<string, unknown> = {}) => ({
  clientId: "gateway",
  userId: null,
  scopes: ["wallet:read"],
  ...overrides,
});

beforeEach(() => {
  mockVerify.mockReset();
  state.client = [{ disabled: false, scopes: ["wallet:read"] }];
});

describe("requireMachineScope", () => {
  it("returns the client id for a valid token carrying the scope", async () => {
    mockVerify.mockResolvedValue(verified());
    expect(await requireMachineScope("Bearer tok", "wallet:read")).toEqual({
      clientId: "gateway",
    });
    expect(mockVerify).toHaveBeenCalledWith("tok");
  });

  it.each([undefined, "", "Basic abc", "bearer tok"])(
    "answers 401 without a Bearer header (%j)",
    async (header) => {
      const err = await rejection(requireMachineScope(header, "wallet:read"));
      expect(err.statusCode).toBe(401);
      expect(mockVerify).not.toHaveBeenCalled();
    },
  );

  it("answers 401 for a token that does not verify", async () => {
    mockVerify.mockResolvedValue(null);
    const err = await rejection(
      requireMachineScope("Bearer tok", "wallet:read"),
    );
    expect(err.statusCode).toBe(401);
  });

  it("answers 403 for a user-bound token", async () => {
    mockVerify.mockResolvedValue(verified({ userId: "u1" }));
    const err = await rejection(
      requireMachineScope("Bearer tok", "wallet:read"),
    );
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("AUTH_011");
  });

  it("answers 403 when the token lacks the scope", async () => {
    mockVerify.mockResolvedValue(verified({ scopes: ["m2m"] }));
    const err = await rejection(
      requireMachineScope("Bearer tok", "wallet:read"),
    );
    expect(err.statusCode).toBe(403);
  });

  it("answers 403 when the client no longer exists", async () => {
    mockVerify.mockResolvedValue(verified());
    state.client = [];
    const err = await rejection(
      requireMachineScope("Bearer tok", "wallet:read"),
    );
    expect(err.statusCode).toBe(403);
  });

  it("answers 403 when the client is disabled", async () => {
    mockVerify.mockResolvedValue(verified());
    state.client = [{ disabled: true, scopes: ["wallet:read"] }];
    const err = await rejection(
      requireMachineScope("Bearer tok", "wallet:read"),
    );
    expect(err.statusCode).toBe(403);
  });

  it("answers 403 when the scope was removed from the client after issuance", async () => {
    mockVerify.mockResolvedValue(verified());
    state.client = [{ disabled: false, scopes: ["m2m"] }];
    const err = await rejection(
      requireMachineScope("Bearer tok", "wallet:read"),
    );
    expect(err.statusCode).toBe(403);
  });

  it("answers 403 when the client has no scopes at all", async () => {
    mockVerify.mockResolvedValue(verified());
    state.client = [{ disabled: false, scopes: null }];
    const err = await rejection(
      requireMachineScope("Bearer tok", "wallet:read"),
    );
    expect(err.statusCode).toBe(403);
  });
});
