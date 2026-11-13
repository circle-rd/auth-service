import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizeInput, PolicyResource } from "./policy.js";

const {
  mockFindResource,
  mockMembership,
  mockLatestGrant,
  mockResolvePlan,
  mockPlanTeamId,
} = vi.hoisted(() => ({
  mockFindResource: vi.fn(),
  mockMembership: vi.fn(),
  mockLatestGrant: vi.fn(),
  mockResolvePlan: vi.fn(),
  mockPlanTeamId: vi.fn(),
}));

vi.mock("./registry.js", () => ({ findResourceByKey: mockFindResource }));
vi.mock("./grants.js", () => ({
  hasActiveMembership: mockMembership,
  findLatestGrant: mockLatestGrant,
}));
vi.mock("../litellm-plan.js", () => ({
  resolveGatewayPlan: mockResolvePlan,
  planTeamId: mockPlanTeamId,
}));

const { authorize, authorizeResource, evaluatePolicy } =
  await import("./policy.js");

const NOW = new Date("2026-11-13T12:00:00Z");

const input = (overrides: Partial<AuthorizeInput> = {}): AuthorizeInput => ({
  subjectId: "subject-a",
  clientId: "client-a",
  resourceType: "model",
  key: "app-a/model-a",
  audience: "https://gateway.example.test",
  ...overrides,
});

const resource = (overrides: Partial<PolicyResource> = {}): PolicyResource => ({
  id: "resource-1",
  key: "app-a/model-a",
  resourceType: "model",
  status: "published",
  ownerApplicationId: "owner-app",
  ownerApplicationSlug: "app-a",
  ...overrides,
});

const membershipGrant = () => ({
  kind: "membership" as const,
  planName: "Team",
  allowedClientIds: null,
  expiresAt: null,
  revokedAt: null,
});

const explicitGrant = (overrides: Record<string, unknown> = {}) => ({
  kind: "explicit" as const,
  planName: "Team",
  allowedClientIds: null,
  expiresAt: null,
  revokedAt: null,
  ...overrides,
});

beforeEach(() => {
  mockFindResource.mockReset();
  mockMembership.mockReset().mockResolvedValue(false);
  mockLatestGrant.mockReset().mockResolvedValue(null);
  mockResolvePlan.mockReset().mockResolvedValue(null);
  mockPlanTeamId
    .mockReset()
    .mockImplementation((slug: string, plan: string) => `${slug}:${plan}`);
});

describe("evaluatePolicy", () => {
  it("allows a published resource with a valid grant", () => {
    const decision = evaluatePolicy(input(), {
      resource: resource(),
      grant: membershipGrant(),
      now: NOW,
    });
    expect(decision).toEqual({
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
    });
  });

  it.each([
    ["subjectId", ""],
    ["clientId", "  "],
    ["audience", ""],
    ["key", ""],
  ])("denies an empty %s", (field, value) => {
    const decision = evaluatePolicy(input({ [field]: value }), {
      resource: resource(),
      grant: membershipGrant(),
      now: NOW,
    });
    expect(decision).toEqual({ decision: "deny", reason: "invalid_input" });
  });

  it("denies an unknown resource", () => {
    expect(
      evaluatePolicy(input(), { resource: null, grant: null, now: NOW }),
    ).toEqual({ decision: "deny", reason: "not_found" });
  });

  it("denies a requested type that differs from the registry", () => {
    expect(
      evaluatePolicy(input({ resourceType: "workflow" }), {
        resource: resource(),
        grant: membershipGrant(),
        now: NOW,
      }),
    ).toEqual({ decision: "deny", reason: "type_mismatch" });
  });

  it("denies a key that differs from the registry", () => {
    expect(
      evaluatePolicy(input({ key: "app-a/other" }), {
        resource: resource(),
        grant: membershipGrant(),
        now: NOW,
      }),
    ).toEqual({ decision: "deny", reason: "key_mismatch" });
  });

  it("denies a disabled resource", () => {
    expect(
      evaluatePolicy(input(), {
        resource: resource({ status: "disabled" }),
        grant: membershipGrant(),
        now: NOW,
      }),
    ).toEqual({ decision: "deny", reason: "disabled" });
  });

  it("denies a draft resource", () => {
    expect(
      evaluatePolicy(input(), {
        resource: resource({ status: "draft" }),
        grant: membershipGrant(),
        now: NOW,
      }),
    ).toEqual({ decision: "deny", reason: "not_published" });
  });

  it("denies without a grant", () => {
    expect(
      evaluatePolicy(input(), {
        resource: resource(),
        grant: null,
        now: NOW,
      }),
    ).toEqual({ decision: "deny", reason: "no_grant" });
  });

  it("denies a revoked grant", () => {
    expect(
      evaluatePolicy(input(), {
        resource: resource(),
        grant: explicitGrant({ revokedAt: NOW }),
        now: NOW,
      }),
    ).toEqual({ decision: "deny", reason: "revoked" });
  });

  it("denies an expired grant", () => {
    expect(
      evaluatePolicy(input(), {
        resource: resource(),
        grant: explicitGrant({ expiresAt: NOW }),
        now: NOW,
      }),
    ).toEqual({ decision: "deny", reason: "expired" });
  });

  it("allows an explicit grant that expires in the future", () => {
    const decision = evaluatePolicy(input(), {
      resource: resource(),
      grant: explicitGrant({
        expiresAt: new Date(NOW.getTime() + 60_000),
      }),
      now: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("denies a client outside allowed_client_ids", () => {
    expect(
      evaluatePolicy(input(), {
        resource: resource(),
        grant: explicitGrant({ allowedClientIds: ["client-b"] }),
        now: NOW,
      }),
    ).toEqual({ decision: "deny", reason: "client_not_allowed" });
  });

  it("allows a client inside allowed_client_ids", () => {
    const decision = evaluatePolicy(input(), {
      resource: resource(),
      grant: explicitGrant({ allowedClientIds: ["client-a"] }),
      now: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("denies when no plan can be resolved", () => {
    expect(
      evaluatePolicy(input(), {
        resource: resource(),
        grant: explicitGrant({ planName: null }),
        now: NOW,
      }),
    ).toEqual({ decision: "deny", reason: "no_plan" });
  });
});

describe("authorizeResource", () => {
  it("uses active membership when the subject belongs to the owner application", async () => {
    mockMembership.mockResolvedValue(true);
    mockResolvePlan.mockResolvedValue({
      applicationSlug: "app-a",
      planName: "Pro",
      teamId: "app-a:pro",
    });
    const decision = await authorizeResource(resource(), input(), NOW);
    expect(decision.decision).toBe("allow");
    expect(decision).toMatchObject({
      planName: "Pro",
      teamId: "app-a:Pro",
      grantKind: "membership",
    });
  });

  it("denies membership access when the owner plan does not resolve", async () => {
    mockMembership.mockResolvedValue(true);
    const decision = await authorizeResource(resource(), input(), NOW);
    expect(decision).toEqual({ decision: "deny", reason: "no_plan" });
  });

  it("falls back to the latest explicit grant", async () => {
    mockLatestGrant.mockResolvedValue({
      id: "grant-1",
      subjectId: "subject-a",
      ownerApplicationId: "owner-app",
      resourceId: "resource-1",
      planId: "plan-1",
      allowedClientIds: ["client-a"],
      expiresAt: null,
      revokedAt: null,
      createdBy: "owner",
      createdAt: NOW,
      planName: "Team",
    });
    const decision = await authorizeResource(resource(), input(), NOW);
    expect(decision.decision).toBe("allow");
    expect(decision).toMatchObject({ grantKind: "explicit" });
  });

  it("denies a revoked explicit grant", async () => {
    mockLatestGrant.mockResolvedValue({
      id: "grant-1",
      subjectId: "subject-a",
      ownerApplicationId: "owner-app",
      resourceId: "resource-1",
      planId: "plan-1",
      allowedClientIds: null,
      expiresAt: null,
      revokedAt: NOW,
      createdBy: "owner",
      createdAt: NOW,
      planName: "Team",
    });
    const decision = await authorizeResource(resource(), input(), NOW);
    expect(decision).toEqual({ decision: "deny", reason: "revoked" });
  });

  it("denies a missing resource", async () => {
    const decision = await authorizeResource(null, input(), NOW);
    expect(decision).toEqual({ decision: "deny", reason: "not_found" });
  });
});

describe("authorize", () => {
  it("normalises the key and loads the resource", async () => {
    mockFindResource.mockResolvedValue(resource());
    mockMembership.mockResolvedValue(true);
    mockResolvePlan.mockResolvedValue({ planName: "Team" });
    const decision = await authorize(input({ key: "app-a/model-a" }));
    expect(decision.decision).toBe("allow");
    expect(mockFindResource).toHaveBeenCalledWith("app-a/model-a");
  });

  it.each([
    ["", "empty"],
    ["app-a", "missing slug"],
    ["https://app-a/model-a", "transport URL"],
    ["App-A/model-a", "uppercase"],
  ])("denies malformed key %j (%s) before querying", async (key) => {
    const decision = await authorize(input({ key }));
    expect(decision).toEqual({ decision: "deny", reason: "invalid_input" });
    expect(mockFindResource).not.toHaveBeenCalled();
  });

  it("denies when the registry has no row for the key", async () => {
    mockFindResource.mockResolvedValue(null);
    expect(await authorize(input())).toEqual({
      decision: "deny",
      reason: "not_found",
    });
  });

  it("denies a type mismatch before loading the grant", async () => {
    mockFindResource.mockResolvedValue(resource());
    const decision = await authorize(input({ resourceType: "workflow" }));
    expect(decision).toEqual({ decision: "deny", reason: "type_mismatch" });
    expect(mockMembership).not.toHaveBeenCalled();
    expect(mockLatestGrant).not.toHaveBeenCalled();
  });

  it("denies empty inputs before querying", async () => {
    const decision = await authorize(input({ subjectId: "" }));
    expect(decision).toEqual({ decision: "deny", reason: "invalid_input" });
    expect(mockFindResource).not.toHaveBeenCalled();
  });
});
