import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  appRoles,
  applications,
  userAppRoles,
  userApplications,
} from "../db/schema.js";
import { resourceGrants, resources } from "../db/resource-schema.js";
import { user as userTable } from "../db/auth-schema.js";
import {
  createResourceGrant,
  revokeResourceGrant,
  updateResourceGrantPermission,
} from "../services/resources/grants.js";
import {
  acceptResourceInvitation,
  createResourceInvitation,
} from "../services/resources/invitations.js";
import { listAccessibleResources } from "../services/resources/access.js";
import { authorize } from "../services/resources/policy.js";
import {
  createResource,
  getResource,
} from "../services/resources/registry.js";
import { completeResourceValidation } from "../services/resources/validation.js";
import {
  createApplicationScheme,
  enableSchemeForApplication,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import { cleanDb } from "./helpers/db.js";
import { makeUserSession } from "./helpers/auth.js";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";

let handle: AuthServerHandle;
let appId: string;

async function seedUser(id: string): Promise<void> {
  await db.insert(userTable).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function projectResource() {
  const resource = await createResource({
    applicationId: appId,
    scheme: "gine",
    locator: `job_${Math.random().toString(36).slice(2)}`,
    displayName: "Job",
    ownerType: "user",
    ownerId: "owner",
  });
  await completeResourceValidation({
    resourceId: resource.id,
    clientId: "perm-app",
    result: "validated",
  });
  return getResource(resource.id);
}

async function modelResource() {
  const [row] = await db
    .insert(resources)
    .values({
      applicationId: appId,
      scheme: "llm",
      locator: "perm-app/model",
      uri: "llm://perm-app/model",
      displayName: "Model",
      ownerType: "application",
      ownerId: appId,
      status: "validated",
    })
    .returning();
  if (!row) throw new Error("resource seed failed");
  return getResource(row.id);
}

function ask(uri: string, subjectId: string, permission?: "read" | "write") {
  return authorize({
    subjectId,
    caller: { id: appId, slug: "perm-app" },
    resourceUri: uri,
    audience: config.betterAuth.url,
    permission,
  });
}

beforeAll(async () => {
  handle = await makeAuthServer();
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
  await syncBuiltinSchemes();
  const [app] = await db
    .insert(applications)
    .values({
      name: "Perm app",
      slug: "perm-app",
      isActive: true,
      resourceSharingEnabled: true,
    })
    .returning();
  if (!app) throw new Error("application seed failed");
  appId = app.id;
  await enableSchemeForApplication(appId, "llm");
  await createApplicationScheme({
    applicationId: appId,
    scheme: "gine",
    displayName: "Job",
    validatorUrl: "https://gine.example/validate",
  });
  for (const id of ["owner", "reader", "admin"]) {
    await seedUser(id);
    await db
      .insert(userApplications)
      .values({ userId: id, applicationId: appId, isActive: true });
  }
  const [role] = await db
    .insert(appRoles)
    .values({ applicationId: appId, name: "admin" })
    .returning();
  if (!role) throw new Error("role seed failed");
  await db
    .insert(userAppRoles)
    .values({ userId: "admin", applicationId: appId, roleId: role.id });
});

describe("grant permission levels", () => {
  it("defaults a grant to read and stores write where the scheme supports it", async () => {
    const resource = await projectResource();
    const plain = await createResourceGrant({
      resourceId: resource.id,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "owner",
    });
    expect(plain.permission).toBe("read");

    await revokeResourceGrant(plain.id, "owner");
    const strong = await createResourceGrant({
      resourceId: resource.id,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "owner",
      permission: "write",
    });
    expect(strong.permission).toBe("write");
  });

  it("refuses write on a single-action built-in scheme", async () => {
    const model = await modelResource();
    await expect(
      createResourceGrant({
        resourceId: model.id,
        subjectType: "user",
        subjectId: "reader",
        actorUserId: "admin",
        permission: "write",
      }),
    ).rejects.toMatchObject({ code: "RES_014" });
    const ok = await createResourceGrant({
      resourceId: model.id,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "admin",
    });
    expect(ok.permission).toBe("read");
  });

  it("admits a request only when the effective level covers the level asked", async () => {
    const resource = await projectResource();
    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "owner",
    });

    const read = await ask(resource.uri, "reader");
    expect(read).toMatchObject({ decision: "allow", permission: "read" });
    await expect(ask(resource.uri, "reader", "write")).resolves.toEqual({
      decision: "deny",
      reason: "insufficient_permission",
    });
    await expect(ask(resource.uri, "owner", "write")).resolves.toMatchObject({
      decision: "allow",
      permission: "write",
      accessKind: "owner",
    });
  });

  it("keeps the strongest of several applicable grants", async () => {
    const resource = await projectResource();
    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "owner",
      permission: "read",
    });
    await db.insert(resourceGrants).values({
      resourceId: resource.id,
      subjectType: "everyone",
      subjectId: null,
      permission: "write",
      createdBy: "admin",
    });
    await expect(ask(resource.uri, "reader", "write")).resolves.toMatchObject({
      decision: "allow",
      permission: "write",
    });
  });

  it("reports the effective level in the accessible listing", async () => {
    const resource = await projectResource();
    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "owner",
    });
    const before = await listAccessibleResources({ subjectId: "reader" });
    expect(before.find((r) => r.resourceId === resource.id)?.permission).toBe(
      "read",
    );
    const [grant] = await db.select().from(resourceGrants);
    if (!grant) throw new Error("grant missing");
    await updateResourceGrantPermission(grant.id, "write", "owner");
    const after = await listAccessibleResources({ subjectId: "reader" });
    expect(after.find((r) => r.resourceId === resource.id)?.permission).toBe(
      "write",
    );
    const owner = await listAccessibleResources({ subjectId: "owner" });
    expect(owner.find((r) => r.resourceId === resource.id)?.permission).toBe(
      "write",
    );
  });

  it("changes the level in place and refuses to change an inactive grant", async () => {
    const resource = await projectResource();
    const grant = await createResourceGrant({
      resourceId: resource.id,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "owner",
    });
    const updated = await updateResourceGrantPermission(
      grant.id,
      "write",
      "owner",
    );
    expect(updated).toMatchObject({
      id: grant.id,
      permission: "write",
      createdBy: grant.createdBy,
    });
    await expect(
      updateResourceGrantPermission(grant.id, "read", "reader"),
    ).rejects.toMatchObject({ code: "RES_002" });

    await revokeResourceGrant(grant.id, "owner");
    await expect(
      updateResourceGrantPermission(grant.id, "read", "owner"),
    ).rejects.toMatchObject({ code: "RES_015" });
  });

  it("carries the level through an invitation to the grant", async () => {
    const resource = await createResource({
      applicationId: appId,
      scheme: "gine",
      locator: "shared_job",
      displayName: "Shared job",
      ownerType: "application",
      ownerId: appId,
    });
    await completeResourceValidation({
      resourceId: resource.id,
      clientId: "perm-app",
      result: "validated",
    });
    const created = await createResourceInvitation({
      email: "newcomer@example.com",
      resourceId: resource.id,
      actorUserId: "admin",
      permission: "write",
    });
    expect(created.invitation.permission).toBe("write");
    await seedUser("newcomer");
    const grant = await acceptResourceInvitation({
      token: created.token,
      subjectId: "newcomer",
      email: "newcomer@example.com",
      emailVerified: true,
    });
    expect(grant.permission).toBe("write");

    await expect(
      createResourceInvitation({
        email: "other@example.com",
        resourceId: (await modelResource()).id,
        actorUserId: "admin",
        permission: "write",
      }),
    ).rejects.toMatchObject({ code: "RES_014" });
  });
});

describe("grant permission levels over HTTP", () => {
  function asUser(id: string): void {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      makeUserSession(id) as unknown as Awaited<
        ReturnType<typeof auth.api.getSession>
      >,
    );
  }

  it("creates, lists, validates and changes the level", async () => {
    const resource = await projectResource();
    asUser("owner");

    const created = await handle.app.inject({
      method: "POST",
      url: `/api/user/resources/${resource.id}/grants`,
      payload: { subjectType: "user", subjectId: "reader", permission: "write" },
    });
    expect(created.statusCode).toBe(201);
    const grantId = created.json().grant.id as string;
    expect(created.json().grant.permission).toBe("write");

    const listed = await handle.app.inject({
      method: "GET",
      url: `/api/user/resources/${resource.id}/grants`,
    });
    expect(listed.json().grants[0].permission).toBe("write");

    const unknown = await handle.app.inject({
      method: "POST",
      url: `/api/user/resources/${resource.id}/grants`,
      payload: { subjectType: "everyone", permission: "admin" },
    });
    expect(unknown.statusCode).toBe(400);

    const patched = await handle.app.inject({
      method: "PATCH",
      url: `/api/user/resources/${resource.id}/grants/${grantId}`,
      payload: { permission: "read" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().grant).toMatchObject({ id: grantId, permission: "read" });

    const stray = await handle.app.inject({
      method: "PATCH",
      url: `/api/user/resources/${resource.id}/grants/${grantId}`,
      payload: { permission: "read", subjectId: "owner" },
    });
    expect(stray.statusCode).toBe(400);
  });

  it("refuses an unsupported level with 400", async () => {
    const model = await modelResource();
    asUser("admin");
    const res = await handle.app.inject({
      method: "POST",
      url: `/api/user/resources/${model.id}/grants`,
      payload: { subjectType: "user", subjectId: "reader", permission: "write" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("RES_014");
  });
});
