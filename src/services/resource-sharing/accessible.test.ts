import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListPublished, mockAuthorizeResource } = vi.hoisted(() => ({
  mockListPublished: vi.fn(),
  mockAuthorizeResource: vi.fn(),
}));

vi.mock("./registry.js", () => ({
  listPublishedResourcesByType: mockListPublished,
}));
vi.mock("./policy.js", () => ({
  authorizeResource: mockAuthorizeResource,
}));

const { listAccessibleResources } = await import("./accessible.js");

const input = {
  subjectId: "subject-a",
  clientId: "client-a",
  resourceType: "model" as const,
  key: "app-a/model-a",
  audience: "https://gateway.example.test",
};

const resource = {
  id: "resource-1",
  ownerApplicationId: "owner-app",
  resourceType: "model" as const,
  key: "app-a/model-a",
  displayName: "Model A",
  upstreamRef: null,
  status: "published" as const,
  visibility: "invited_only" as const,
  defaultPlanId: null,
  createdAt: new Date("2026-11-13T12:00:00Z"),
  updatedAt: new Date("2026-11-13T12:00:00Z"),
  ownerApplicationSlug: "app-a",
};

beforeEach(() => {
  mockListPublished.mockReset();
  mockAuthorizeResource.mockReset();
});

describe("listAccessibleResources", () => {
  it("returns only allowed resources with canonical identity", async () => {
    mockListPublished.mockResolvedValue([
      resource,
      { ...resource, id: "resource-2", key: "app-b/model-b" },
    ]);
    mockAuthorizeResource
      .mockResolvedValueOnce({
        decision: "allow",
        resourceId: "resource-1",
        resourceKey: "app-a/model-a",
        ownerApplicationId: "owner-app",
        ownerApplicationSlug: "app-a",
        planName: "Team",
        teamId: "app-a:Team",
        subjectId: "subject-a",
        clientId: "client-a",
        resourceType: "model",
        grantKind: "membership",
      })
      .mockResolvedValueOnce({ decision: "deny", reason: "no_grant" });

    const accessible = await listAccessibleResources(input);
    expect(accessible).toEqual([
      {
        resourceId: "resource-1",
        resourceKey: "app-a/model-a",
        resourceUri: "llm://app-a/model-a",
        resourceType: "model",
        displayName: "Model A",
        ownerApplicationSlug: "app-a",
        planName: "Team",
        teamId: "app-a:Team",
      },
    ]);
  });

  it("evaluates every candidate with its canonical key", async () => {
    mockListPublished.mockResolvedValue([resource]);
    mockAuthorizeResource.mockResolvedValue({ decision: "deny", reason: "x" });
    await listAccessibleResources(input);
    expect(mockAuthorizeResource).toHaveBeenCalledWith(resource, {
      ...input,
      key: "app-a/model-a",
    });
  });

  it("returns an empty list when nothing is published", async () => {
    mockListPublished.mockResolvedValue([]);
    expect(await listAccessibleResources(input)).toEqual([]);
  });
});
