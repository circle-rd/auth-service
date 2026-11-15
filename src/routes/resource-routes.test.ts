import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestApp } from "../tests/helpers/app.js";

const {
  mockRequireSession,
  mockRequireAppDelegation,
  mockRequireResourceAppAdmin,
  mockGetRequestSession,
  mockListAccessible,
  mockListSharingApps,
  mockAssertActiveMember,
  mockAssertCanManage,
  mockCreateGrant,
  mockGetGrant,
  mockListGrants,
  mockRevokeGrant,
  mockListAppGrants,
  mockAcceptInvitation,
  mockCreateInvitation,
  mockListInvitations,
  mockRevokeInvitation,
  mockCreateResource,
  mockDisableResource,
  mockGetResource,
  mockListMyResources,
  mockRequestValidation,
  mockMarkValidated,
  mockLinkInventory,
  mockUpdateResource,
  mockListAppResources,
  mockGetScheme,
  mockListSchemeCatalog,
  mockCreateScheme,
  mockUpdateScheme,
  mockEnableScheme,
  mockDisableScheme,
  mockGetUsage,
  mockListAccessEvents,
  mockAddMember,
  mockListOwnerApps,
  mockListOwnerMembers,
  mockListOwnerPlans,
  mockSendInvitation,
  mockMailConfigured,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockRequireAppDelegation: vi.fn(),
  mockRequireResourceAppAdmin: vi.fn(),
  mockGetRequestSession: vi.fn(),
  mockListAccessible: vi.fn(),
  mockListSharingApps: vi.fn(),
  mockAssertActiveMember: vi.fn(),
  mockAssertCanManage: vi.fn(),
  mockCreateGrant: vi.fn(),
  mockGetGrant: vi.fn(),
  mockListGrants: vi.fn(),
  mockRevokeGrant: vi.fn(),
  mockListAppGrants: vi.fn(),
  mockAcceptInvitation: vi.fn(),
  mockCreateInvitation: vi.fn(),
  mockListInvitations: vi.fn(),
  mockRevokeInvitation: vi.fn(),
  mockCreateResource: vi.fn(),
  mockDisableResource: vi.fn(),
  mockGetResource: vi.fn(),
  mockListMyResources: vi.fn(),
  mockRequestValidation: vi.fn(),
  mockMarkValidated: vi.fn(),
  mockLinkInventory: vi.fn(),
  mockUpdateResource: vi.fn(),
  mockListAppResources: vi.fn(),
  mockGetScheme: vi.fn(),
  mockListSchemeCatalog: vi.fn(),
  mockCreateScheme: vi.fn(),
  mockUpdateScheme: vi.fn(),
  mockEnableScheme: vi.fn(),
  mockDisableScheme: vi.fn(),
  mockGetUsage: vi.fn(),
  mockListAccessEvents: vi.fn(),
  mockAddMember: vi.fn(),
  mockListOwnerApps: vi.fn(),
  mockListOwnerMembers: vi.fn(),
  mockListOwnerPlans: vi.fn(),
  mockSendInvitation: vi.fn(),
  mockMailConfigured: vi.fn(),
}));

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../middleware.js", () => ({
  requireSession: mockRequireSession,
  requireAppDelegation: mockRequireAppDelegation,
  requireResourceAppAdmin: mockRequireResourceAppAdmin,
  getRequestSession: mockGetRequestSession,
}));
vi.mock("../services/resources/access.js", () => ({
  listAccessibleResources: mockListAccessible,
  listSharingApplications: mockListSharingApps,
}));
vi.mock("../services/resources/apps.js", () => ({
  addExistingUserToApplication: mockAddMember,
  listOwnerApplications: mockListOwnerApps,
  listOwnerMembers: mockListOwnerMembers,
  listOwnerPlans: mockListOwnerPlans,
}));
vi.mock("../services/resources/authority.js", () => ({
  assertActiveMember: mockAssertActiveMember,
  assertCanManageResource: mockAssertCanManage,
}));
vi.mock("../services/resources/grants.js", () => ({
  createResourceGrant: mockCreateGrant,
  getGrantForResource: mockGetGrant,
  listGrantsForResource: mockListGrants,
  listGrantsForApplication: mockListAppGrants,
  revokeResourceGrant: mockRevokeGrant,
}));
vi.mock("../services/resources/invitations.js", () => ({
  acceptResourceInvitation: mockAcceptInvitation,
  buildResourceInvitationUrl: (token: string) =>
    `https://auth.test/resource-invitation?token=${token}`,
  createResourceInvitation: mockCreateInvitation,
  listResourceInvitationsForApplication: mockListInvitations,
  revokeResourceInvitation: mockRevokeInvitation,
  toPublicResourceInvitation: (invitation: unknown) => invitation,
}));
vi.mock("../services/resources/registry.js", () => ({
  createResource: mockCreateResource,
  disableResource: mockDisableResource,
  getResource: mockGetResource,
  listResourcesForOwner: mockListMyResources,
  listResourcesForApplication: mockListAppResources,
  markResourceValidated: mockMarkValidated,
  requestResourceValidation: mockRequestValidation,
  updateResource: mockUpdateResource,
}));
vi.mock("../services/gateway-inventory.js", () => ({
  linkResourceToGatewayObject: mockLinkInventory,
}));
vi.mock("../services/resources/scheme-service.js", () => ({
  createApplicationScheme: mockCreateScheme,
  disableSchemeForApplication: mockDisableScheme,
  enableSchemeForApplication: mockEnableScheme,
  getResourceScheme: mockGetScheme,
  listApplicationSchemeCatalog: mockListSchemeCatalog,
  updateApplicationScheme: mockUpdateScheme,
}));
vi.mock("../services/resources/usage.js", () => ({
  getApplicationUsage: mockGetUsage,
  listAccessEvents: mockListAccessEvents,
  USAGE_GROUP_BY: ["user", "resource"],
}));
vi.mock("../services/email.js", () => ({
  sendResourceInvitationEmail: mockSendInvitation,
}));
vi.mock("../services/mail/index.js", () => ({
  isMailConfigured: mockMailConfigured,
}));

const { userResourceRoutes } = await import("./user-resources.js");
const { appResourceRoutes } = await import("./app-resources.js");

const APP = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "22222222-2222-4222-8222-222222222222";
const GRANT = "33333333-3333-4333-8333-333333333333";
const INVITATION = "44444444-4444-4444-8444-444444444444";

const resource = {
  id: RESOURCE,
  applicationId: APP,
  applicationSlug: "app-a",
  applicationName: "App A",
  scheme: "gine",
  locator: "project_1",
  uri: "gine://project_1",
  displayName: "Project 1",
  ownerType: "user",
  ownerId: "user-1",
  status: "validated",
  listed: false,
  metadata: {},
  validationRequestedAt: null,
  validatedAt: new Date("2026-11-15T10:00:00Z"),
  validationError: null,
  createdAt: new Date("2026-11-15T09:00:00Z"),
  updatedAt: new Date("2026-11-15T10:00:00Z"),
};

const app = createTestApp();
beforeAll(async () => {
  await app.register(userResourceRoutes, { prefix: "/api/user" });
  await app.register(appResourceRoutes, { prefix: "/api/user" });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  for (const mock of [
    mockRequireSession,
    mockRequireAppDelegation,
    mockRequireResourceAppAdmin,
    mockGetRequestSession,
    mockListAccessible,
    mockListSharingApps,
    mockAssertActiveMember,
    mockAssertCanManage,
    mockCreateGrant,
    mockGetGrant,
    mockListGrants,
    mockRevokeGrant,
    mockListAppGrants,
    mockAcceptInvitation,
    mockCreateInvitation,
    mockListInvitations,
    mockRevokeInvitation,
    mockCreateResource,
    mockDisableResource,
    mockGetResource,
    mockListMyResources,
    mockRequestValidation,
    mockMarkValidated,
    mockLinkInventory,
    mockUpdateResource,
    mockListAppResources,
    mockGetScheme,
    mockListSchemeCatalog,
    mockCreateScheme,
    mockUpdateScheme,
    mockEnableScheme,
    mockDisableScheme,
    mockGetUsage,
    mockListAccessEvents,
    mockAddMember,
    mockListOwnerApps,
    mockListOwnerMembers,
    mockListOwnerPlans,
    mockSendInvitation,
    mockMailConfigured,
  ]) {
    mock.mockReset();
  }
  mockRequireSession.mockResolvedValue("user-1");
  mockRequireAppDelegation.mockResolvedValue("user-1");
  mockRequireResourceAppAdmin.mockResolvedValue("user-1");
  mockGetRequestSession.mockResolvedValue({
    user: {
      id: "user-1",
      email: "user@example.com",
      name: "User",
      emailVerified: true,
    },
  });
  mockListAccessible.mockResolvedValue([]);
  mockListSharingApps.mockResolvedValue([]);
  mockListMyResources.mockResolvedValue([resource]);
  mockGetResource.mockResolvedValue(resource);
  mockGetScheme.mockResolvedValue({
    scheme: "gine",
    displayName: "Projet Re:GINE",
    enabled: true,
  });
  mockGetGrant.mockResolvedValue({ id: GRANT, resourceId: RESOURCE });
  mockMailConfigured.mockReturnValue(false);
  mockLinkInventory.mockResolvedValue(true);
  mockMarkValidated.mockResolvedValue({
    ...resource,
    status: "validated",
    validatedAt: new Date("2026-11-15T12:00:00Z"),
  });
});

describe("user resource routes", () => {
  it("returns the global catalogue", async () => {
    mockListAccessible.mockResolvedValue([
      {
        resourceId: RESOURCE,
        resourceUri: "gine://project_1",
        scheme: "gine",
        displayName: "Project 1",
        applicationId: APP,
        applicationSlug: "app-a",
        applicationName: "App A",
        ownerType: "user",
        ownerId: "user-1",
        accessKind: "owner",
      },
    ]);
    mockListSharingApps.mockResolvedValue([{ slug: "app-a", name: "App A" }]);
    const res = await app.inject({
      method: "GET",
      url: "/api/user/resource-catalogue",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resources).toHaveLength(1);
  });

  it("creates a user-owned resource in an application the user belongs to", async () => {
    mockCreateResource.mockResolvedValue(resource);
    const res = await app.inject({
      method: "POST",
      url: "/api/user/resources",
      payload: {
        applicationId: APP,
        scheme: "gine",
        locator: "project_1",
        displayName: "Project 1",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockAssertActiveMember).toHaveBeenCalledWith("user-1", APP);
    expect(mockCreateResource).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: APP,
        scheme: "gine",
        ownerType: "user",
        ownerId: "user-1",
      }),
    );
    expect(res.json().resource.uri).toBe("gine://project_1");
  });

  it("rejects an invalid resource body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/user/resources",
      payload: {
        applicationId: APP,
        scheme: "GINE",
        locator: "",
        displayName: "",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreateResource).not.toHaveBeenCalled();
  });

  it("validates a LiteLLM resource against the inventory without a callback", async () => {
    mockRequestValidation.mockResolvedValue({
      ...resource,
      scheme: "llm",
      uri: "llm://app-a/gpt-x",
      locator: "app-a/gpt-x",
      status: "pending_validation",
    });
    mockGetScheme.mockResolvedValue({
      scheme: "llm",
      displayName: "Model",
      enabled: true,
      validatorUrl: null,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/user/resources/${RESOURCE}/validation-request`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockLinkInventory).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: "llm" }),
    );
    expect(mockMarkValidated).toHaveBeenCalledWith(RESOURCE);
    expect(res.json().resource.status).toBe("validated");
    expect(res.json().validatorUrl).toBeNull();
  });

  it("creates a grant through the authority-aware service", async () => {
    mockCreateGrant.mockResolvedValue({
      id: GRANT,
      resourceId: RESOURCE,
      subjectType: "user",
      subjectId: "user-2",
      revokedAt: null,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/user/resources/${RESOURCE}/grants`,
      payload: { subjectType: "user", subjectId: "user-2" },
    });
    expect(res.statusCode).toBe(201);
    expect(mockCreateGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: RESOURCE,
        subjectType: "user",
        subjectId: "user-2",
        actorUserId: "user-1",
      }),
    );
  });

  it("accepts an invitation for the authenticated verified subject", async () => {
    mockAcceptInvitation.mockResolvedValue({ id: GRANT, resourceId: RESOURCE });
    const res = await app.inject({
      method: "POST",
      url: "/api/user/resource-invitations/accept",
      payload: { token: "token-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockAcceptInvitation).toHaveBeenCalledWith({
      token: "token-1",
      subjectId: "user-1",
      email: "user@example.com",
      emailVerified: true,
    });
  });
});

describe("application resource routes", () => {
  it("registers an application scheme", async () => {
    mockCreateScheme.mockResolvedValue({
      scheme: "gine",
      displayName: "Projet Re:GINE",
      enabled: true,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/user/apps/${APP}/schemes`,
      payload: { scheme: "gine", displayName: "Projet Re:GINE" },
    });
    expect(res.statusCode).toBe(201);
    expect(mockCreateScheme).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: APP, scheme: "gine" }),
    );
  });

  it("adds an existing user to the application", async () => {
    mockAddMember.mockResolvedValue({
      userId: "user-2",
      name: "Invitee",
      email: "invitee@example.com",
      created: true,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/user/apps/${APP}/members`,
      payload: { email: "invitee@example.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(mockAddMember).toHaveBeenCalledWith(
      "user-1",
      APP,
      "invitee@example.com",
    );
  });

  it("creates an invitation and returns the one-time URL", async () => {
    mockCreateInvitation.mockResolvedValue({
      invitation: {
        id: INVITATION,
        email: "invitee@example.com",
        resourceId: RESOURCE,
        expiresAt: new Date("2026-11-18T00:00:00Z"),
        consumedAt: null,
        revokedAt: null,
        createdBy: "user-1",
        createdAt: new Date("2026-11-15T00:00:00Z"),
      },
      token: "token-1",
      resource,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/user/apps/${APP}/invitations`,
      payload: { email: "invitee@example.com", resourceId: RESOURCE },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().inviteUrl).toContain("token-1");
    expect(res.json().emailSent).toBe(false);
    expect(mockSendInvitation).not.toHaveBeenCalled();
  });

  it("keeps the invitation when the email transport fails", async () => {
    mockMailConfigured.mockReturnValue(true);
    mockSendInvitation.mockRejectedValue(new Error("smtp unavailable"));
    mockCreateInvitation.mockResolvedValue({
      invitation: {
        id: INVITATION,
        email: "invitee@example.com",
        resourceId: RESOURCE,
        expiresAt: new Date("2026-11-18T00:00:00Z"),
        consumedAt: null,
        revokedAt: null,
        createdBy: "user-1",
        createdAt: new Date("2026-11-15T00:00:00Z"),
      },
      token: "token-1",
      resource,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/user/apps/${APP}/invitations`,
      payload: { email: "invitee@example.com", resourceId: RESOURCE },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().inviteUrl).toContain("token-1");
    expect(res.json().emailSent).toBe(false);
  });

  it("defaults usage to the last 30 days and rejects an inverted range", async () => {
    mockGetUsage.mockResolvedValue({
      groupBy: "user",
      from: "2026-10-16T00:00:00.000Z",
      to: "2026-11-15T00:00:00.000Z",
      items: [],
      totals: {
        calls: 0,
        unsupportedCalls: 0,
        tokenlessCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: "0",
      },
      hasMore: false,
      nextOffset: null,
    });
    const ok = await app.inject({
      method: "GET",
      url: `/api/user/apps/${APP}/usage`,
    });
    expect(ok.statusCode).toBe(200);
    expect(mockGetUsage).toHaveBeenCalledWith(
      APP,
      expect.objectContaining({ groupBy: "user", limit: 50, offset: 0 }),
    );
    const defaults = mockGetUsage.mock.calls[0]?.[1];
    const span =
      new Date(defaults.to).getTime() - new Date(defaults.from).getTime();
    expect(span).toBe(30 * 24 * 60 * 60 * 1000);

    const inverted = await app.inject({
      method: "GET",
      url: `/api/user/apps/${APP}/usage?from=2030-01-02T00:00:00.000Z&to=2030-01-01T00:00:00.000Z`,
    });
    expect(inverted.statusCode).toBe(400);
  });

  it("lists access events for an application", async () => {
    mockListAccessEvents.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: `/api/user/apps/${APP}/access-events?decision=deny`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockListAccessEvents).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: APP, decision: "deny" }),
    );
  });
});
