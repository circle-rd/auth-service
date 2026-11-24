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
  mockRequireUserOrBearer,
  mockRequireAppDelegation,
  mockRequireResourceAppAdmin,
  mockGetRequestSession,
  mockListAccessible,
  mockListSharingApps,
  mockAssertActiveMember,
  mockIsPlatformAdmin,
  mockIsApplicationAdmin,
  mockListModelCandidates,
  mockAssertCanManage,
  mockAssertCanManageGrants,
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
  mockRemoveResource,
  mockResolveAudience,
  mockActiveMemberIdByEmail,
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
  mockDeleteScheme,
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
  bearerClient,
  mockLoadSharingApp,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockRequireUserOrBearer: vi.fn(),
  mockRequireAppDelegation: vi.fn(),
  mockRequireResourceAppAdmin: vi.fn(),
  mockGetRequestSession: vi.fn(),
  mockListAccessible: vi.fn(),
  mockListSharingApps: vi.fn(),
  mockAssertActiveMember: vi.fn(),
  mockIsPlatformAdmin: vi.fn(),
  mockIsApplicationAdmin: vi.fn(),
  mockListModelCandidates: vi.fn(),
  mockAssertCanManage: vi.fn(),
  mockAssertCanManageGrants: vi.fn(),
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
  mockRemoveResource: vi.fn(),
  mockResolveAudience: vi.fn(),
  mockActiveMemberIdByEmail: vi.fn(),
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
  mockDeleteScheme: vi.fn(),
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
  // The OAuth client of the bearer token: null means the auth-service UI session.
  bearerClient: { current: null as string | null },
  mockLoadSharingApp: vi.fn(),
}));

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../middleware.js", () => ({
  requireSession: mockRequireSession,
  requireUserOrBearer: mockRequireUserOrBearer,
  requireUserOrBearerCaller: async (...args: unknown[]) => {
    const userId = (await mockRequireUserOrBearer(...args)) as string;
    return userId ? { userId, clientId: bearerClient.current } : null;
  },
  requireAppDelegation: mockRequireAppDelegation,
  requireResourceAppAdmin: mockRequireResourceAppAdmin,
  getRequestSession: mockGetRequestSession,
}));
vi.mock("../services/resources/application-scope.js", () => ({
  loadSharingApplicationBySlug: mockLoadSharingApp,
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
  assertCanManageGrants: mockAssertCanManageGrants,
  isPlatformAdmin: mockIsPlatformAdmin,
  isApplicationAdmin: mockIsApplicationAdmin,
}));
vi.mock("../services/resources/grants.js", () => ({
  createResourceGrant: mockCreateGrant,
  getGrantForResource: mockGetGrant,
  revokeResourceGrant: mockRevokeGrant,
  updateResourceGrantPermission: vi.fn(),
}));
vi.mock("../services/resources/grant-views.js", () => ({
  listGrantsForResource: mockListGrants,
  listGrantsForResources: vi.fn(),
  listActiveGrantCounts: vi.fn(),
  listGrantsForApplication: mockListAppGrants,
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
vi.mock("../services/resources/audience.js", () => ({
  activeMemberIdByEmail: mockActiveMemberIdByEmail,
  resolveAudience: mockResolveAudience,
}));
vi.mock("../services/resources/gateway-declaration.js", () => ({
  validateRelayDeclaration: async (resource: unknown) => resource,
}));
vi.mock("../services/usernames.js", () => ({
  getUserIdentity: async () => null,
}));
vi.mock("../services/resources/registry.js", () => ({
  createResource: mockCreateResource,
  removeResource: mockRemoveResource,
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
  deleteApplicationScheme: mockDeleteScheme,
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
vi.mock("../services/resources/model-candidates.js", () => ({
  listModelCandidates: mockListModelCandidates,
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
  bearerClient.current = null;
  for (const mock of [
    mockLoadSharingApp,
    mockRequireSession,
    mockRequireUserOrBearer,
    mockRequireAppDelegation,
    mockRequireResourceAppAdmin,
    mockGetRequestSession,
    mockListAccessible,
    mockListSharingApps,
    mockAssertActiveMember,
    mockIsPlatformAdmin,
    mockIsApplicationAdmin,
    mockListModelCandidates,
    mockAssertCanManage,
    mockAssertCanManageGrants,
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
    mockRemoveResource,
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
    mockDeleteScheme,
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
  mockRequireUserOrBearer.mockResolvedValue("user-1");
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
  mockIsPlatformAdmin.mockResolvedValue(true);
  mockIsApplicationAdmin.mockResolvedValue(true);
  mockListModelCandidates.mockResolvedValue([]);
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

describe("user resource routes confined to the bearer's application", () => {
  const OTHER_APP = "99999999-9999-4999-8999-999999999999";

  beforeEach(() => {
    mockRequireUserOrBearer.mockResolvedValue("user-1");
    bearerClient.current = "consumer-app";
    mockLoadSharingApp.mockResolvedValue({
      id: APP,
      slug: "consumer-app",
      allowedResources: [],
    });
  });

  it("refuses a client that is not an application with resource sharing", async () => {
    mockLoadSharingApp.mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/api/user/accessible-resources",
    });
    expect(res.statusCode).toBe(403);
    expect(mockListAccessible).not.toHaveBeenCalled();
  });

  it("lists the scope of the client's application, not the user's global view", async () => {
    mockListAccessible.mockResolvedValue([]);
    await app.inject({ method: "GET", url: "/api/user/accessible-resources" });
    expect(mockListAccessible).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: "user-1",
        caller: { id: APP, slug: "consumer-app" },
      }),
    );
  });

  it("hides a resource of another application as not found", async () => {
    mockGetResource.mockResolvedValue({
      id: RESOURCE,
      applicationId: OTHER_APP,
    });
    for (const [method, url] of [
      ["GET", `/api/user/resources/${RESOURCE}`],
      ["DELETE", `/api/user/resources/${RESOURCE}`],
      ["GET", `/api/user/resources/${RESOURCE}/grants`],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
    }
    expect(mockRemoveResource).not.toHaveBeenCalled();
  });

  it("refuses to create a resource in another application", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/user/resources",
      payload: {
        applicationId: OTHER_APP,
        scheme: "gine",
        displayName: "Project",
        locator: "project_1",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(mockCreateResource).not.toHaveBeenCalled();
  });

  it("shares several resources with an application and reports each outcome", async () => {
    mockGetResource.mockResolvedValue({ id: RESOURCE, applicationId: APP });
    mockCreateGrant.mockResolvedValue({ id: "grant-1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/user/resource-shares",
      payload: { resourceIds: [RESOURCE], applicationSlug: "other-app" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      { resourceId: RESOURCE, grantId: "grant-1", code: null },
    ]);
    expect(mockCreateGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "application",
        subjectId: "other-app",
        actorUserId: "user-1",
      }),
    );
  });

  it("refuses to share a resource of another application", async () => {
    mockGetResource.mockResolvedValue({
      id: RESOURCE,
      applicationId: OTHER_APP,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/user/resource-shares",
      payload: { resourceIds: [RESOURCE], applicationSlug: "other-app" },
    });
    expect(res.statusCode).toBe(404);
    expect(mockCreateGrant).not.toHaveBeenCalled();
  });

  it("keeps the global view for the auth-service UI session", async () => {
    bearerClient.current = null;
    mockListAccessible.mockResolvedValue([]);
    await app.inject({ method: "GET", url: "/api/user/accessible-resources" });
    expect(mockLoadSharingApp).not.toHaveBeenCalled();
    expect(mockListAccessible).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: "user-1", caller: undefined }),
    );
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
    expect(Array.isArray(res.json().enabledSchemes)).toBe(true);
  });

  it("lists managed model candidates to an application administrator", async () => {
    mockListModelCandidates.mockResolvedValue([
      {
        name: "bmz/qwen",
        locator: "app-a/bmz/qwen",
        source: "managed",
        owned: false,
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/user/apps/${APP}/model-candidates/managed`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toHaveLength(1);
    expect(mockListModelCandidates).toHaveBeenCalledWith({
      appId: APP,
      userId: "user-1",
      source: "managed",
    });
    expect(mockAssertActiveMember).not.toHaveBeenCalled();
  });

  it("checks membership before listing native candidates to a member", async () => {
    mockIsApplicationAdmin.mockResolvedValue(false);
    const res = await app.inject({
      method: "GET",
      url: `/api/user/apps/${APP}/model-candidates/native`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockAssertActiveMember).toHaveBeenCalledWith("user-1", APP);
    expect(mockListModelCandidates).toHaveBeenCalledWith({
      appId: APP,
      userId: "user-1",
      source: "native",
    });
  });

  it("grants the declared audience at creation and removes the resource when refused", async () => {
    mockCreateResource.mockResolvedValue(resource);
    mockResolveAudience.mockResolvedValue({
      subjectType: "organization",
      subjectId: "org-1",
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/user/resources",
      payload: {
        applicationId: APP,
        scheme: "gine",
        displayName: "Project 1",
        audience: { type: "organization", organizationId: "org-1" },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(mockCreateGrant).toHaveBeenCalledWith({
      resourceId: resource.id,
      subjectType: "organization",
      subjectId: "org-1",
      actorUserId: "user-1",
    });

    mockCreateGrant.mockRejectedValueOnce(new Error("refused"));
    const refused = await app.inject({
      method: "POST",
      url: "/api/user/resources",
      payload: {
        applicationId: APP,
        scheme: "gine",
        displayName: "Project 1",
        audience: { type: "everyone" },
      },
    });
    expect(refused.statusCode).toBe(500);
    expect(mockRemoveResource).toHaveBeenCalledWith(resource.id, "user-1");
  });

  it("rejects an audience that mixes an e-mail and a user id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/user/resources",
      payload: {
        applicationId: APP,
        scheme: "gine",
        displayName: "Project 1",
        audience: { type: "user", userId: "u2", email: "a@example.com" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreateResource).not.toHaveBeenCalled();
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

  it("refuses oversized free-form metadata", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/user/resources",
      payload: {
        applicationId: APP,
        scheme: "gine",
        locator: "project_1",
        displayName: "Project 1",
        metadata: { blob: "x".repeat(5000) },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreateResource).not.toHaveBeenCalled();
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

  it("leaves a gateway resource pending when a non-administrator validates it", async () => {
    mockIsPlatformAdmin.mockResolvedValue(false);
    mockRequestValidation.mockResolvedValue({
      ...resource,
      scheme: "llm",
      status: "pending_validation",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/user/resources/${RESOURCE}/validation-request`,
    });
    expect(res.statusCode).toBe(403);
    expect(mockLinkInventory).not.toHaveBeenCalled();
    expect(mockMarkValidated).not.toHaveBeenCalled();
  });

  it("tells the caller whether the resource was deleted or only disabled", async () => {
    mockRemoveResource.mockResolvedValueOnce({ resource, removed: true });
    let res = await app.inject({
      method: "DELETE",
      url: `/api/user/resources/${RESOURCE}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toBe(true);
    expect(mockRemoveResource).toHaveBeenCalledWith(RESOURCE, "user-1");

    mockRemoveResource.mockResolvedValueOnce({
      resource: { ...resource, status: "disabled" },
      removed: false,
    });
    res = await app.inject({
      method: "DELETE",
      url: `/api/user/resources/${RESOURCE}`,
    });
    expect(res.json()).toMatchObject({
      removed: false,
      resource: { status: "disabled" },
    });
  });

  it("lists grants through the grant-specific authority", async () => {
    mockGetResource.mockResolvedValue(resource);
    mockListGrants.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: `/api/user/resources/${RESOURCE}/grants`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockAssertCanManageGrants).toHaveBeenCalledWith("user-1", resource);
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

  it("resolves a user grant named by e-mail", async () => {
    mockActiveMemberIdByEmail.mockResolvedValue("user-9");
    mockCreateGrant.mockResolvedValue({
      id: GRANT,
      resourceId: RESOURCE,
      subjectType: "user",
      subjectId: "user-9",
      revokedAt: null,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/user/resources/${RESOURCE}/grants`,
      payload: { subjectType: "user", subjectEmail: "member@example.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(mockActiveMemberIdByEmail).toHaveBeenCalledWith(
      "member@example.com",
      APP,
    );
    expect(mockCreateGrant).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: "user-9" }),
    );
  });

  it("refuses both a subject id and an e-mail", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/user/resources/${RESOURCE}/grants`,
      payload: {
        subjectType: "user",
        subjectId: "user-2",
        subjectEmail: "member@example.com",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreateGrant).not.toHaveBeenCalled();
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

  it("deletes an application scheme for an application admin only", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/user/apps/${APP}/schemes/gine`,
    });
    expect(res.statusCode).toBe(204);
    expect(mockDeleteScheme).toHaveBeenCalledWith(APP, "gine");

    mockDeleteScheme.mockClear();
    mockRequireResourceAppAdmin.mockResolvedValue(null);
    const denied = await app.inject({
      method: "DELETE",
      url: `/api/user/apps/${APP}/schemes/gine`,
    });
    expect(denied.statusCode).not.toBe(204);
    expect(mockDeleteScheme).not.toHaveBeenCalled();
  });

  it("answers an add-member request the same way whether or not it added anyone", async () => {
    mockAddMember.mockResolvedValueOnce({
      email: "invitee@example.com",
      applicationName: "App",
      applicationSlug: "app",
    });
    const added = await app.inject({
      method: "POST",
      url: `/api/user/apps/${APP}/members`,
      payload: { email: "invitee@example.com" },
    });
    mockAddMember.mockResolvedValueOnce(null);
    const ignored = await app.inject({
      method: "POST",
      url: `/api/user/apps/${APP}/members`,
      payload: { email: "unknown@example.com" },
    });
    expect(added.statusCode).toBe(202);
    expect(ignored.statusCode).toBe(202);
    expect(ignored.body).toBe(added.body);
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
      expect.objectContaining({ groupBy: "resource", limit: 50, offset: 0 }),
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

  it("reserves per-user usage grouping to application administrators", async () => {
    mockIsApplicationAdmin.mockResolvedValue(false);
    const res = await app.inject({
      method: "GET",
      url: `/api/user/apps/${APP}/usage?groupBy=user`,
    });
    expect(res.statusCode).toBe(403);
    expect(mockGetUsage).not.toHaveBeenCalled();
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
