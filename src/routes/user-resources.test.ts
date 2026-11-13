import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors.js";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  requireAppDelegation: vi.fn(),
  getRequestSession: vi.fn(),
  listAccessibleResources: vi.fn(),
  listSharedResources: vi.fn(),
  getSharedResource: vi.fn(),
  createSharedResource: vi.fn(),
  updateSharedResource: vi.fn(),
  listGrantsForOwner: vi.fn(),
  getGrantForOwner: vi.fn(),
  revokeResourceGrant: vi.fn(),
  updateResourceGrant: vi.fn(),
  createResourceInvitation: vi.fn(),
  acceptResourceInvitation: vi.fn(),
  buildResourceInvitationUrl: vi.fn(),
  toPublicResourceInvitation: vi.fn(),
  sendResourceInvitationEmail: vi.fn(),
  isMailConfigured: vi.fn(),
}));

vi.mock("../middleware.js", () => ({
  requireSession: mocks.requireSession,
  requireAppDelegation: mocks.requireAppDelegation,
  getRequestSession: mocks.getRequestSession,
}));
vi.mock("../services/resource-sharing/accessible.js", () => ({
  listAccessibleResources: mocks.listAccessibleResources,
}));
vi.mock("../services/resource-sharing/registry.js", () => ({
  listSharedResources: mocks.listSharedResources,
  getSharedResource: mocks.getSharedResource,
  createSharedResource: mocks.createSharedResource,
  updateSharedResource: mocks.updateSharedResource,
}));
vi.mock("../services/resource-sharing/grants.js", () => ({
  listGrantsForOwner: mocks.listGrantsForOwner,
  getGrantForOwner: mocks.getGrantForOwner,
  revokeResourceGrant: mocks.revokeResourceGrant,
  updateResourceGrant: mocks.updateResourceGrant,
}));
vi.mock("../services/resource-sharing/invitations.js", () => ({
  createResourceInvitation: mocks.createResourceInvitation,
  acceptResourceInvitation: mocks.acceptResourceInvitation,
  buildResourceInvitationUrl: mocks.buildResourceInvitationUrl,
  toPublicResourceInvitation: mocks.toPublicResourceInvitation,
}));
vi.mock("../services/email.js", () => ({
  sendResourceInvitationEmail: mocks.sendResourceInvitationEmail,
}));
vi.mock("../services/mail/index.js", () => ({
  isMailConfigured: mocks.isMailConfigured,
}));

const { userResourceRoutes } = await import("./user-resources.js");

const APP = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "22222222-2222-4222-8222-222222222222";
const GRANT = "33333333-3333-4333-8333-333333333333";
const PLAN = "44444444-4444-4444-8444-444444444444";
const USER = "user-a";

let app: FastifyInstance;

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.requireSession.mockResolvedValue(USER);
  mocks.requireAppDelegation.mockResolvedValue(USER);
  mocks.getRequestSession.mockResolvedValue({
    user: {
      id: USER,
      email: "owner@example.test",
      name: "Owner",
      emailVerified: true,
    },
  });
  mocks.isMailConfigured.mockReturnValue(false);
  mocks.buildResourceInvitationUrl.mockReturnValue("https://auth.test/inv?x=1");
  mocks.toPublicResourceInvitation.mockImplementation((value) => value);
  app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send(error.toJSON());
    }
    return reply
      .status(400)
      .send({ error: { message: (error as Error).message } });
  });
  await app.register(userResourceRoutes);
  await app.ready();
});

describe("GET /accessible-resources", () => {
  it("lists every type for the session subject", async () => {
    mocks.listAccessibleResources
      .mockResolvedValueOnce([{ resourceId: "r1" }])
      .mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/accessible-resources?clientId=app-b",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resources: [{ resourceId: "r1" }] });
    expect(mocks.listAccessibleResources).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: USER, clientId: "app-b" }),
    );
    expect(mocks.listAccessibleResources).toHaveBeenCalledTimes(4);
  });

  it("filters to one type and rejects a missing client id", async () => {
    mocks.listAccessibleResources.mockResolvedValue([]);
    const filtered = await app.inject({
      method: "GET",
      url: "/accessible-resources?clientId=app-b&resourceType=model",
    });
    expect(filtered.statusCode).toBe(200);
    expect(mocks.listAccessibleResources).toHaveBeenCalledTimes(1);

    const missing = await app.inject({
      method: "GET",
      url: "/accessible-resources",
    });
    expect(missing.statusCode).toBe(400);
  });
});

describe("owner resource routes", () => {
  it("lists, reads, creates, patches and soft-deletes", async () => {
    mocks.listSharedResources.mockResolvedValue([{ id: RESOURCE }]);
    let res = await app.inject({
      method: "GET",
      url: `/apps/${APP}/shared-resources`,
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.requireAppDelegation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      APP,
      "resources:read",
    );

    mocks.getSharedResource.mockResolvedValue({
      id: RESOURCE,
      ownerApplicationId: APP,
    });
    res = await app.inject({
      method: "GET",
      url: `/apps/${APP}/shared-resources/${RESOURCE}`,
    });
    expect(res.statusCode).toBe(200);

    mocks.createSharedResource.mockResolvedValue({ id: RESOURCE });
    res = await app.inject({
      method: "POST",
      url: `/apps/${APP}/shared-resources`,
      payload: {
        resourceType: "model",
        slug: "model-a",
        displayName: "Model A",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mocks.createSharedResource).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerApplicationId: APP,
        resourceType: "model",
        slug: "model-a",
      }),
    );

    mocks.updateSharedResource.mockResolvedValue({ id: RESOURCE });
    res = await app.inject({
      method: "PATCH",
      url: `/apps/${APP}/shared-resources/${RESOURCE}`,
      payload: { displayName: "Renamed" },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({
      method: "DELETE",
      url: `/apps/${APP}/shared-resources/${RESOURCE}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.updateSharedResource).toHaveBeenLastCalledWith(RESOURCE, {
      status: "disabled",
    });
  });

  it("fails foreign resources with the same 404 as missing ones", async () => {
    mocks.getSharedResource.mockResolvedValue({
      id: RESOURCE,
      ownerApplicationId: "another-app",
    });
    const res = await app.inject({
      method: "GET",
      url: `/apps/${APP}/shared-resources/${RESOURCE}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "RES_002" } });
  });

  it("rejects invalid bodies and path ids", async () => {
    let res = await app.inject({
      method: "POST",
      url: `/apps/${APP}/shared-resources`,
      payload: { resourceType: "ssh_host" },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: "GET",
      url: "/apps/not-a-uuid/shared-resources",
    });
    expect(res.statusCode).toBe(400);

    mocks.getSharedResource.mockResolvedValue({
      id: RESOURCE,
      ownerApplicationId: APP,
    });
    res = await app.inject({
      method: "PATCH",
      url: `/apps/${APP}/shared-resources/${RESOURCE}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("stops when the delegation guard has answered", async () => {
    mocks.requireAppDelegation.mockImplementation(async (_req, reply) => {
      await reply.status(404).send({ error: { code: "RES_004" } });
      return "";
    });
    const res = await app.inject({
      method: "GET",
      url: `/apps/${APP}/shared-resources`,
    });
    expect(res.statusCode).toBe(404);
    expect(mocks.listSharedResources).not.toHaveBeenCalled();
  });
});

describe("owner grant routes", () => {
  it("lists, updates and revokes grants", async () => {
    mocks.listGrantsForOwner.mockResolvedValue([{ id: GRANT }]);
    let res = await app.inject({
      method: "GET",
      url: `/apps/${APP}/grants`,
    });
    expect(res.statusCode).toBe(200);

    mocks.updateResourceGrant.mockResolvedValue({ id: GRANT });
    res = await app.inject({
      method: "PUT",
      url: `/apps/${APP}/grants/${GRANT}`,
      payload: {
        planId: PLAN,
        expiresAt: "2027-01-01T00:00:00.000Z",
        allowedClientIds: ["app-b"],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.updateResourceGrant).toHaveBeenCalledWith(
      GRANT,
      APP,
      expect.objectContaining({ planId: PLAN, expiresAt: expect.any(Date) }),
    );

    mocks.getGrantForOwner.mockResolvedValue({ id: GRANT });
    mocks.revokeResourceGrant.mockResolvedValue({ id: GRANT });
    res = await app.inject({
      method: "DELETE",
      url: `/apps/${APP}/grants/${GRANT}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("answers foreign grants uniformly", async () => {
    mocks.updateResourceGrant.mockRejectedValue(
      new ApiError(404, "RES_007", "Resource grant not found"),
    );
    const res = await app.inject({
      method: "PUT",
      url: `/apps/${APP}/grants/${GRANT}`,
      payload: { planId: PLAN },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "RES_007" } });
  });

  it("rejects an empty patch", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/apps/${APP}/grants/${GRANT}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("invitation routes", () => {
  it("creates and emails an invitation", async () => {
    mocks.isMailConfigured.mockReturnValue(true);
    mocks.createResourceInvitation.mockResolvedValue({
      invitation: { id: "invitation-1" },
      token: "raw-token",
      ownerAppSlug: "app-a",
      ownerAppName: "App A",
      planName: "free",
      resourceName: "Model A",
    });
    const res = await app.inject({
      method: "POST",
      url: `/apps/${APP}/invitations`,
      payload: {
        email: "invitee@example.test",
        planId: PLAN,
        resourceId: RESOURCE,
        ttlHours: 24,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ emailSent: true });
    expect(mocks.sendResourceInvitationEmail).toHaveBeenCalledWith(
      "invitee@example.test",
      expect.objectContaining({
        planName: "free",
        resourceName: "Model A",
        expiresInHours: 24,
      }),
    );
  });

  it("does not attempt mail when the transport is not configured", async () => {
    mocks.createResourceInvitation.mockResolvedValue({
      invitation: { id: "invitation-1" },
      token: "raw-token",
      ownerAppSlug: "app-a",
      ownerAppName: "App A",
      planName: "free",
    });
    const res = await app.inject({
      method: "POST",
      url: `/apps/${APP}/invitations`,
      payload: { email: "invitee@example.test", planId: PLAN },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ emailSent: false });
    expect(mocks.sendResourceInvitationEmail).not.toHaveBeenCalled();
  });

  it("accepts a token for the authenticated subject", async () => {
    mocks.acceptResourceInvitation.mockResolvedValue({ id: GRANT });
    const res = await app.inject({
      method: "POST",
      url: "/resource-invitations/accept",
      payload: { token: "raw-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.acceptResourceInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "raw-token",
        subjectId: USER,
        email: "owner@example.test",
        emailVerified: true,
      }),
    );
  });
});
