import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPublishedResourcesByType: vi.fn(),
  loadPolicyGrant: vi.fn(),
  evaluateSubjectAccess: vi.fn(),
}));

vi.mock("./registry.js", () => ({
  listPublishedResourcesByType: mocks.listPublishedResourcesByType,
}));
vi.mock("./policy.js", () => ({
  loadPolicyGrant: mocks.loadPolicyGrant,
  evaluateSubjectAccess: mocks.evaluateSubjectAccess,
}));

const { listResourceCatalogue } = await import("./catalogue.js");

const resource = (overrides: Record<string, unknown> = {}) => ({
  id: "resource-1",
  key: "app-a/model-a",
  resourceType: "model",
  displayName: "Model A",
  status: "published",
  ownerApplicationId: "app-a-id",
  ownerApplicationSlug: "app-a",
  ...overrides,
});

const allowed = (allowedClientIds: string[] | null) => ({
  allowed: true,
  planName: "Team",
  grant: {
    kind: "explicit" as const,
    planName: "Team",
    allowedClientIds,
    expiresAt: null,
    revokedAt: null,
  },
});

beforeEach(() => {
  mocks.listPublishedResourcesByType.mockReset().mockResolvedValue([]);
  mocks.loadPolicyGrant.mockReset().mockResolvedValue(null);
  mocks.evaluateSubjectAccess.mockReset();
});

describe("listResourceCatalogue", () => {
  it("maps only resources the subject may reach", async () => {
    mocks.listPublishedResourcesByType.mockImplementation((type: string) =>
      Promise.resolve(type === "model" ? [resource()] : []),
    );
    mocks.loadPolicyGrant.mockResolvedValue(allowed(null).grant);
    mocks.evaluateSubjectAccess
      .mockReturnValueOnce(allowed(null))
      .mockReturnValue({ allowed: false, reason: "no_grant" });

    await expect(
      listResourceCatalogue({ subjectId: "subject-1" }),
    ).resolves.toEqual([
      {
        resourceId: "resource-1",
        resourceKey: "app-a/model-a",
        resourceUri: "llm://app-a/model-a",
        resourceType: "model",
        displayName: "Model A",
        ownerApplicationSlug: "app-a",
        planName: "Team",
        restrictedToClientIds: null,
      },
    ]);
  });

  it("keeps client restrictions and skips an empty client list", async () => {
    mocks.listPublishedResourcesByType.mockImplementation((type: string) =>
      Promise.resolve(
        type === "model"
          ? [
              resource({ id: "restricted", key: "app-a/model-b" }),
              resource({ id: "empty", key: "app-a/model-c" }),
            ]
          : [],
      ),
    );
    mocks.loadPolicyGrant
      .mockResolvedValueOnce(allowed(["client-b"]).grant)
      .mockResolvedValueOnce(allowed([]).grant);
    mocks.evaluateSubjectAccess
      .mockReturnValueOnce(allowed(["client-b"]))
      .mockReturnValueOnce(allowed([]));

    const items = await listResourceCatalogue({ subjectId: "subject-1" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      resourceId: "restricted",
      restrictedToClientIds: ["client-b"],
    });
  });

  it("returns resources from two owners in one session", async () => {
    mocks.listPublishedResourcesByType.mockImplementation((type: string) =>
      Promise.resolve(
        type === "model"
          ? [
              resource({ id: "a", key: "app-a/model-a" }),
              resource({
                id: "b",
                key: "app-b/model-b",
                ownerApplicationSlug: "app-b",
              }),
            ]
          : [],
      ),
    );
    mocks.loadPolicyGrant.mockResolvedValue(allowed(null).grant);
    mocks.evaluateSubjectAccess
      .mockReturnValueOnce(allowed(null))
      .mockReturnValueOnce(allowed(null));

    const items = await listResourceCatalogue({ subjectId: "subject-1" });
    expect(items.map((item) => item.ownerApplicationSlug)).toEqual([
      "app-a",
      "app-b",
    ]);
  });
});
