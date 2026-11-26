import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSelect,
  mockInsert,
  mockUpdate,
  mockActive,
  mockMemberships,
  mockLoadApp,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockActive: vi.fn(),
  mockMemberships: vi.fn(),
  mockLoadApp: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate },
}));
vi.mock("./resources/identity-facts.js", () => ({
  isAccountActive: mockActive,
  listActiveMemberships: mockMemberships,
}));
vi.mock("./resources/application-scope.js", () => ({
  loadSharingApplication: mockLoadApp,
}));

const {
  GATEWAY_KEY_RE,
  createGatewayKey,
  maskGatewayKey,
  listActiveGatewayKeys,
  resolveGatewayKey,
  revokeGatewayKey,
} = await import("./gateway-keys.js");

type QueryChain = {
  from: () => QueryChain;
  where: () => QueryChain;
  orderBy: () => Promise<unknown[]>;
  limit: () => Promise<unknown[]>;
  then: Promise<unknown[]>["then"];
};

function queryResult(rows: unknown[]): QueryChain {
  const promise = Promise.resolve(rows);
  const chain: QueryChain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => promise,
    limit: () => promise,
    then: promise.then.bind(promise),
  };
  return chain;
}

function insertResult(row: unknown) {
  const values = vi.fn((_input: unknown) => ({
    returning: () => Promise.resolve([row]),
  }));
  mockInsert.mockReturnValueOnce({ values });
  return values;
}

const APP_ID = "22222222-2222-4222-8222-222222222222";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-26T12:00:00Z");
const row = {
  id: KEY_ID,
  label: "IDE",
  organizationId: null,
  maskedKey: "cgk_AbCdEf…wXyZ",
  createdAt: NOW,
  lastUsedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockActive.mockResolvedValue(true);
  mockMemberships.mockResolvedValue(new Set([APP_ID]));
  mockLoadApp.mockResolvedValue({
    id: APP_ID,
    slug: "consumer-app",
    allowedResources: [],
  });
});

describe("gateway key persistence", () => {
  it("lists active keys for one user", async () => {
    mockSelect.mockReturnValueOnce(queryResult([row]));
    await expect(listActiveGatewayKeys("user-1", APP_ID)).resolves.toEqual([
      row,
    ]);
  });

  it("stores only the hash and masked key, and returns the full key once", async () => {
    mockSelect
      .mockReturnValueOnce(queryResult([]))
      .mockReturnValueOnce(queryResult([{ id: "member-1" }]));
    const valuesMock = insertResult({ ...row, organizationId: "org_1" });
    const created = await createGatewayKey({
      userId: "user-1",
      application: { id: APP_ID, slug: "consumer-app" },
      organizationId: "org_1",
      label: "IDE",
    });
    expect(created.key).toMatch(GATEWAY_KEY_RE);
    expect(created.id).toBe(KEY_ID);
    const values = valuesMock.mock.calls[0]?.[0] as unknown as {
      keyHash: string;
      maskedKey: string;
      organizationId: string;
    };
    expect(values.keyHash).toHaveLength(43);
    expect(values.keyHash).not.toBe(created.key);
    expect(values.maskedKey).toBe(maskGatewayKey(created.key));
    expect(values.organizationId).toBe("org_1");
  });

  it("refuses creation beyond the active-key limit", async () => {
    mockSelect.mockReturnValueOnce(
      queryResult(Array.from({ length: 20 }, () => ({ id: KEY_ID }))),
    );
    await expect(
      createGatewayKey({
        userId: "user-1",
        application: { id: APP_ID, slug: "consumer-app" },
        organizationId: null,
        label: "IDE",
      }),
    ).rejects.toMatchObject({ code: "KEY_005" });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("refuses an organization the user does not belong to", async () => {
    mockSelect
      .mockReturnValueOnce(queryResult([]))
      .mockReturnValueOnce(queryResult([]));
    await expect(
      createGatewayKey({
        userId: "user-1",
        application: { id: APP_ID, slug: "consumer-app" },
        organizationId: "org_1",
        label: "IDE",
      }),
    ).rejects.toMatchObject({ code: "KEY_004" });
  });

  it("revokes an owned key idempotently and rejects an unknown one", async () => {
    mockUpdate.mockReturnValue({
      set: () => ({ where: () => Promise.resolve() }),
    });
    mockSelect
      .mockReturnValueOnce(queryResult([{ id: KEY_ID, revokedAt: NOW }]))
      .mockReturnValueOnce(queryResult([{ id: KEY_ID, revokedAt: null }]))
      .mockReturnValueOnce(queryResult([]));

    await expect(
      revokeGatewayKey("user-1", KEY_ID, APP_ID),
    ).resolves.toBeUndefined();
    expect(mockUpdate).not.toHaveBeenCalled();

    await expect(
      revokeGatewayKey("user-1", KEY_ID, APP_ID),
    ).resolves.toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    await expect(
      revokeGatewayKey("user-1", KEY_ID, APP_ID),
    ).rejects.toMatchObject({
      code: "KEY_002",
    });
  });
});

describe("gateway key resolution admission", () => {
  const key = `cgk_${"A".repeat(43)}`;

  function keyRow(organizationId: string | null = null) {
    return {
      id: KEY_ID,
      userId: "user-1",
      applicationId: APP_ID,
      organizationId,
    };
  }

  it("returns the user, application and pool", async () => {
    mockSelect
      .mockReturnValueOnce(queryResult([keyRow("org_1")]))
      .mockReturnValueOnce(queryResult([{ id: "member-1" }]));
    await expect(resolveGatewayKey(key)).resolves.toEqual({
      keyId: KEY_ID,
      userId: "user-1",
      caller: { id: APP_ID, slug: "consumer-app" },
      pool: "org_1",
    });
  });

  it("refuses an unknown or revoked key", async () => {
    mockSelect.mockReturnValueOnce(queryResult([]));
    await expect(resolveGatewayKey(key)).rejects.toMatchObject({
      code: "KEY_001",
    });
  });

  it("refuses a banned user and a closed application", async () => {
    mockSelect.mockReturnValueOnce(queryResult([keyRow()]));
    mockActive.mockResolvedValueOnce(false);
    await expect(resolveGatewayKey(key)).rejects.toMatchObject({
      code: "KEY_004",
    });

    mockSelect.mockReturnValueOnce(queryResult([keyRow()]));
    mockLoadApp.mockResolvedValueOnce(null);
    await expect(resolveGatewayKey(key)).rejects.toMatchObject({
      code: "KEY_004",
    });
  });

  it("refuses a lost application membership", async () => {
    mockSelect.mockReturnValueOnce(queryResult([keyRow()]));
    mockMemberships.mockResolvedValueOnce(new Set());
    await expect(resolveGatewayKey(key)).rejects.toMatchObject({
      code: "KEY_004",
    });
  });

  it("refuses a pool the user has left", async () => {
    mockSelect
      .mockReturnValueOnce(queryResult([keyRow("org_1")]))
      .mockReturnValueOnce(queryResult([]));
    await expect(resolveGatewayKey(key)).rejects.toMatchObject({
      code: "KEY_004",
    });
  });
});
