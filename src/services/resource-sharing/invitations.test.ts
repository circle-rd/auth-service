import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors.js";

const { mockDb, state, grants } = vi.hoisted(() => {
  const state = {
    results: [] as unknown[][],
    lastValues: undefined as unknown,
  };
  const terminal = () => Promise.resolve(state.results.shift() ?? []);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => terminal(),
    returning: () => terminal(),
    values: (values: unknown) => {
      state.lastValues = values;
      return chain;
    },
    set: (values: unknown) => {
      state.lastValues = values;
      return chain;
    },
  };
  const mockDb = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    transaction: (fn: (tx: unknown) => unknown) => fn(mockDb),
  };
  return {
    state,
    mockDb,
    grants: {
      assertApplicationExists: vi.fn(),
      assertPlanBelongsToOwner: vi.fn(),
      assertResourceBelongsToOwner: vi.fn(),
      createResourceGrant: vi.fn(),
    },
  };
});

vi.mock("../../db/index.js", () => ({ db: mockDb }));
vi.mock("./grants.js", () => ({
  assertApplicationExists: grants.assertApplicationExists,
  assertPlanBelongsToOwner: grants.assertPlanBelongsToOwner,
  assertResourceBelongsToOwner: grants.assertResourceBelongsToOwner,
  createResourceGrant: grants.createResourceGrant,
}));

const {
  acceptResourceInvitation,
  buildResourceInvitationUrl,
  createResourceInvitation,
  hashResourceInvitationToken,
  resourceInvitationState,
  revokeResourceInvitation,
  toPublicResourceInvitation,
} = await import("./invitations.js");

const NOW = new Date("2026-11-13T12:00:00Z");
const OWNER = "app-a-id";
const PLAN = "plan-1";

const invitation = (overrides: Record<string, unknown> = {}) => ({
  id: "invitation-1",
  tokenHash: "hash",
  email: "invitee@example.test",
  ownerApplicationId: OWNER,
  resourceId: null,
  planId: PLAN,
  allowedClientIds: null,
  expiresAt: new Date("2026-11-16T12:00:00Z"),
  consumedAt: null,
  revokedAt: null,
  createdBy: "owner-user",
  createdAt: NOW,
  ...overrides,
});

function rejection(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      return error as ApiError;
    },
  );
}

beforeEach(() => {
  state.results = [];
  state.lastValues = undefined;
  grants.assertApplicationExists.mockReset().mockResolvedValue(undefined);
  grants.assertPlanBelongsToOwner.mockReset().mockResolvedValue(undefined);
  grants.assertResourceBelongsToOwner.mockReset().mockResolvedValue(undefined);
  grants.createResourceGrant.mockReset();
});

describe("resource invitation helper state", () => {
  it("classifies pending, consumed, revoked and expired invitations", () => {
    expect(resourceInvitationState(invitation(), NOW)).toBe("pending");
    expect(resourceInvitationState(invitation({ consumedAt: NOW }), NOW)).toBe(
      "consumed",
    );
    expect(resourceInvitationState(invitation({ revokedAt: NOW }), NOW)).toBe(
      "revoked",
    );
    expect(
      resourceInvitationState(
        invitation({ expiresAt: new Date("2026-11-13T11:00:00Z") }),
        NOW,
      ),
    ).toBe("expired");
  });

  it("hashes tokens and never exposes the hash publicly", () => {
    expect(hashResourceInvitationToken("token")).toHaveLength(43);
    expect(toPublicResourceInvitation(invitation())).not.toHaveProperty(
      "tokenHash",
    );
    expect(buildResourceInvitationUrl("tok en")).toContain("tok%20en");
  });
});

describe("createResourceInvitation", () => {
  it("stores only the token hash and returns email context", async () => {
    state.results = [
      [invitation()],
      [{ slug: "app-a", name: "App A" }],
      [{ name: "free" }],
      [],
    ];
    const created = await createResourceInvitation({
      email: "Invitee@Example.test",
      ownerApplicationId: OWNER,
      planId: PLAN,
      createdBy: "owner-user",
    });
    expect(created.token).not.toBe("");
    expect(created.ownerAppSlug).toBe("app-a");
    expect(created.planName).toBe("free");
    expect(state.lastValues).toMatchObject({
      email: "invitee@example.test",
      ownerApplicationId: OWNER,
      planId: PLAN,
      tokenHash: hashResourceInvitationToken(created.token),
    });
  });

  it("resolves a resource display name for the email", async () => {
    state.results = [
      [invitation({ resourceId: "resource-1" })],
      [{ slug: "app-a", name: "App A" }],
      [{ name: "free" }],
      [{ name: "Model A" }],
    ];
    const created = await createResourceInvitation({
      email: "invitee@example.test",
      ownerApplicationId: OWNER,
      planId: PLAN,
      resourceId: "resource-1",
      createdBy: "owner-user",
    });
    expect(created.resourceName).toBe("Model A");
  });

  it("rejects an invalid lifetime", async () => {
    const error = await rejection(
      createResourceInvitation({
        email: "invitee@example.test",
        ownerApplicationId: OWNER,
        planId: PLAN,
        ttlHours: 0,
        createdBy: "owner-user",
      }),
    );
    expect(error.code).toBe("RES_001");
  });

  it("rejects an empty client allow-list", async () => {
    const error = await rejection(
      createResourceInvitation({
        email: "invitee@example.test",
        ownerApplicationId: OWNER,
        planId: PLAN,
        allowedClientIds: [],
        createdBy: "owner-user",
      }),
    );
    expect(error.code).toBe("RES_001");
  });
});

describe("acceptResourceInvitation", () => {
  const input = {
    token: "token",
    subjectId: "subject-a",
    email: "invitee@example.test",
    emailVerified: true,
    now: NOW,
  };

  it("claims the token and creates the grant in one transaction", async () => {
    const grant = { id: "grant-1" };
    grants.createResourceGrant.mockResolvedValue(grant);
    state.results = [[invitation()], [{ id: "invitation-1" }]];
    await expect(acceptResourceInvitation(input)).resolves.toBe(grant);
    expect(state.lastValues).toEqual({ consumedAt: NOW });
    expect(grants.createResourceGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: "subject-a",
        ownerApplicationId: OWNER,
        planId: PLAN,
      }),
      expect.anything(),
    );
  });

  it("rejects an unknown or already used invitation", async () => {
    state.results = [[]];
    expect((await rejection(acceptResourceInvitation(input))).code).toBe(
      "RES_010",
    );
    state.results = [[invitation({ consumedAt: NOW })]];
    expect((await rejection(acceptResourceInvitation(input))).code).toBe(
      "RES_010",
    );
  });

  it("rejects an expired invitation", async () => {
    state.results = [
      [invitation({ expiresAt: new Date("2026-11-13T11:00:00Z") })],
    ];
    expect((await rejection(acceptResourceInvitation(input))).code).toBe(
      "RES_010",
    );
  });

  it("rejects an email mismatch and an unverified address", async () => {
    state.results = [[invitation()]];
    expect(
      (
        await rejection(
          acceptResourceInvitation({ ...input, email: "other@example.test" }),
        )
      ).code,
    ).toBe("AUTH_014");

    state.results = [[invitation()]];
    expect(
      (
        await rejection(
          acceptResourceInvitation({ ...input, emailVerified: false }),
        )
      ).code,
    ).toBe("AUTH_015");
  });

  it("fails when another request claimed the invitation first", async () => {
    state.results = [[invitation()], []];
    expect((await rejection(acceptResourceInvitation(input))).code).toBe(
      "RES_010",
    );
  });
});

describe("revokeResourceInvitation", () => {
  it("scopes revocation to the owner application", async () => {
    state.results = [[invitation({ revokedAt: NOW })]];
    await expect(
      revokeResourceInvitation("invitation-1", OWNER),
    ).resolves.toMatchObject({ revokedAt: NOW });
  });

  it("answers RES_010 for a foreign or already used invitation", async () => {
    state.results = [[]];
    expect(
      (await rejection(revokeResourceInvitation("invitation-1", OWNER))).code,
    ).toBe("RES_010");
  });
});
