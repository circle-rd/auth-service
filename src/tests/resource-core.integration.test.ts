import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  appDelegations,
  appRoles,
  applications,
  subscriptionPlans,
  userAppRoles,
  userApplications,
  userSubscriptions,
} from "../db/schema.js";
import { member, organization, user as userTable } from "../db/auth-schema.js";
import { resources } from "../db/resource-schema.js";
import { gatewayObjects } from "../db/gateway-schema.js";
import {
  createApplicationScheme,
  deleteApplicationScheme,
  disableSchemeForApplication,
  enableSchemeForApplication,
  listApplicationSchemeCatalog,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import {
  createResource,
  disableResource,
  getResource,
  removeResource,
} from "../services/resources/registry.js";
import { completeResourceValidation } from "../services/resources/validation.js";
import { canManageGrants } from "../services/resources/authority.js";
import { resolveAudience } from "../services/resources/audience.js";
import { authorize } from "../services/resources/policy.js";
import {
  createResourceGrant,
  resolveGrantsForSubject,
} from "../services/resources/grants.js";
import { listAccessibleResources } from "../services/resources/access.js";
import {
  addExistingUserToApplication,
  listOwnerMembers,
} from "../services/resources/apps.js";
import {
  acceptResourceInvitation,
  createResourceInvitation,
} from "../services/resources/invitations.js";
import {
  getApplicationUsage,
  recordAccessEvent,
  recordUsageEvent,
  listAccessEvents,
  sweepResourceMonitoringRetention,
} from "../services/resources/usage.js";
import {
  gatewayTargetForResource,
  listGatewayEntitlements,
} from "../services/gateway-inventory.js";
import { cleanDb } from "./helpers/db.js";

interface Seed {
  appAId: string;
  appBId: string;
  planAId: string;
  ownerId: string;
  memberId: string;
  orgUserId: string;
  planUserId: string;
  outsiderId: string;
  adminId: string;
  appAdminId: string;
  orgId: string;
}

async function seedUser(
  id: string,
  role: string = "user",
): Promise<void> {
  await db.insert(userTable).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seed(): Promise<Seed> {
  const [appA] = await db
    .insert(applications)
    .values({
      name: "App A",
      slug: "app-a",
      isActive: true,
      resourceSharingEnabled: true,
    })
    .returning();
  const [appB] = await db
    .insert(applications)
    .values({
      name: "App B",
      slug: "app-b",
      isActive: true,
      resourceSharingEnabled: true,
    })
    .returning();
  if (!appA || !appB) throw new Error("application seed failed");

  await seedUser("owner");
  await seedUser("member");
  await seedUser("org-user");
  await seedUser("plan-user");
  await seedUser("everyone-user");
  await seedUser("outsider");
  await seedUser("admin", "superadmin");
  await seedUser("app-admin");

  for (const userId of ["owner", "member", "org-user", "plan-user", "everyone-user"]) {
    await db.insert(userApplications).values({
      userId,
      applicationId: appA.id,
      isActive: true,
    });
  }
  await db.insert(userApplications).values({
    userId: "outsider",
    applicationId: appB.id,
    isActive: true,
  });
  await db.insert(userApplications).values({
    userId: "app-admin",
    applicationId: appA.id,
    isActive: true,
  });
  const [adminRole] = await db
    .insert(appRoles)
    .values({ applicationId: appA.id, name: "admin" })
    .returning();
  if (!adminRole) throw new Error("admin role seed failed");
  await db.insert(userAppRoles).values({
    userId: "app-admin",
    applicationId: appA.id,
    roleId: adminRole.id,
  });

  const [planA] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: appA.id, name: "team", features: {} })
    .returning();
  if (!planA) throw new Error("plan seed failed");
  await db.insert(userSubscriptions).values({
    userId: "plan-user",
    applicationId: appA.id,
    planId: planA.id,
    isActive: true,
  });

  const [org] = await db
    .insert(organization)
    .values({
      id: "org-1",
      name: "Org One",
      slug: "org-one",
      createdAt: new Date(),
    })
    .returning();
  if (!org) throw new Error("organization seed failed");
  await db.insert(member).values({
    id: "member-org-1",
    organizationId: org.id,
    userId: "org-user",
    role: "member",
    createdAt: new Date(),
  });

  await syncBuiltinSchemes();
  await enableSchemeForApplication(appA.id, "llm");
  await enableSchemeForApplication(appA.id, "agent");
  await enableSchemeForApplication(appA.id, "mcp");
  await createApplicationScheme({
    applicationId: appA.id,
    scheme: "gine",
    displayName: "Projet Re:GINE",
    validatorUrl: "https://gine.example/validate",
  });

  return {
    appAId: appA.id,
    appBId: appB.id,
    planAId: planA.id,
    ownerId: "owner",
    memberId: "member",
    orgUserId: "org-user",
    planUserId: "plan-user",
    outsiderId: "outsider",
    adminId: "admin",
    appAdminId: "app-admin",
    orgId: org.id,
  };
}

async function validatedResource(
  seedData: Seed,
  overrides: {
    scheme?: string;
    locator?: string;
    validatorClientId?: string;
    displayName?: string;
    ownerType?: "user" | "application";
  } = {},
) {
  const ownerType = overrides.ownerType ?? "user";
  const resource = await createResource({
    applicationId: seedData.appAId,
    scheme: overrides.scheme ?? "gine",
    locator: overrides.locator ?? `project_${Math.random().toString(36).slice(2)}`,
    displayName: overrides.displayName ?? "Project",
    ownerType,
    ownerId: ownerType === "user" ? seedData.ownerId : seedData.appAId,
  });
  await completeResourceValidation({
    resourceId: resource.id,
    clientId: overrides.validatorClientId ?? "app-a",
    result: "validated",
  });
  return getResource(resource.id);
}

beforeEach(async () => {
  await cleanDb();
});

describe("generic resource core", () => {
  it("creates a pending resource and requires validation", async () => {
    const seedData = await seed();
    const resource = await createResource({
      applicationId: seedData.appAId,
      scheme: "gine",
      locator: "project_1",
      displayName: "Project 1",
      ownerType: "user",
      ownerId: seedData.ownerId,
    });
    expect(resource.status).toBe("pending_validation");
    expect(resource.uri).toBe("gine://project_1");

    await expect(
      authorize({
        subjectId: seedData.ownerId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toEqual({ decision: "deny", reason: "not_validated" });

    const validated = await completeResourceValidation({
      resourceId: resource.id,
      clientId: "app-a",
      result: "validated",
    });
    expect(validated.status).toBe("validated");

    await expect(
      authorize({
        subjectId: seedData.ownerId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toMatchObject({ decision: "allow", accessKind: "owner" });
  });

  it("lets an application administrator declare a personal gateway resource", async () => {
    const seedData = await seed();
    const resource = await createResource({
      applicationId: seedData.appAId,
      scheme: "llm",
      locator: "app-a/bmz/qwen3",
      displayName: "Qwen 3",
      ownerType: "user",
      ownerId: seedData.appAdminId,
    });
    expect(resource.status).toBe("pending_validation");
    expect(resource.ownerType).toBe("user");
    expect(resource.ownerId).toBe(seedData.appAdminId);
    expect(resource.uri).toBe("llm://app-a/bmz/qwen3");
  });

  it("lets a regular member declare a personal gateway resource, pending until checked", async () => {
    const seedData = await seed();
    const resource = await createResource({
      applicationId: seedData.appAId,
      scheme: "llm",
      locator: "app-a/bmz/qwen3",
      displayName: "Qwen 3",
      ownerType: "user",
      ownerId: seedData.memberId,
    });
    expect(resource.status).toBe("pending_validation");
  });

  it("refuses a grant from an owner to themselves", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData);
    await expect(
      createResourceGrant({
        resourceId: resource.id,
        subjectType: "user",
        subjectId: seedData.ownerId,
        actorUserId: seedData.ownerId,
      }),
    ).rejects.toMatchObject({ code: "RES_004" });
  });

  it("lets an application administrator open a personal resource to a whole audience", async () => {
    const seedData = await seed();
    const resource = await createResource({
      applicationId: seedData.appAId,
      scheme: "gine",
      locator: "project_admin_audience",
      displayName: "Project",
      ownerType: "user",
      ownerId: seedData.appAdminId,
    });
    await completeResourceValidation({
      resourceId: resource.id,
      clientId: "app-a",
      result: "validated",
    });
    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "everyone",
      subjectId: null,
      actorUserId: seedData.appAdminId,
    });
    await expect(
      authorize({
        subjectId: seedData.memberId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toMatchObject({ decision: "allow", accessKind: "grant" });
  });

  it("refuses an audience an administrator does not belong to, and a member's group grant", async () => {
    const seedData = await seed();
    const resource = await createResource({
      applicationId: seedData.appAId,
      scheme: "gine",
      locator: "project_org_scope",
      displayName: "Project",
      ownerType: "user",
      ownerId: seedData.appAdminId,
    });
    await expect(
      createResourceGrant({
        resourceId: resource.id,
        subjectType: "organization",
        subjectId: seedData.orgId,
        actorUserId: seedData.appAdminId,
      }),
    ).rejects.toMatchObject({ code: "RES_004" });
    const memberResource = await createResource({
      applicationId: seedData.appAId,
      scheme: "gine",
      locator: "project_member_scope",
      displayName: "Project",
      ownerType: "user",
      ownerId: seedData.memberId,
    });
    await expect(
      createResourceGrant({
        resourceId: memberResource.id,
        subjectType: "everyone",
        subjectId: null,
        actorUserId: seedData.memberId,
      }),
    ).rejects.toMatchObject({ code: "RES_004" });
  });

  it("resolves an e-mail recipient only among active members, with one generic refusal", async () => {
    const seedData = await seed();
    await expect(
      resolveAudience(
        { type: "user", email: "member@example.com" },
        seedData.appAId,
      ),
    ).resolves.toEqual({ subjectType: "user", subjectId: "member" });
    const outsider = resolveAudience(
      { type: "user", email: "outsider@example.com" },
      seedData.appAId,
    );
    const unknown = resolveAudience(
      { type: "user", email: "nobody@example.com" },
      seedData.appAId,
    );
    await expect(outsider).rejects.toMatchObject({ code: "RES_001" });
    await expect(unknown).rejects.toMatchObject({ code: "RES_001" });
    await expect(outsider).rejects.toThrow(/active member/);
    await expect(unknown).rejects.toThrow(/active member/);
  });

  it("deletes an application scheme only when no live resource uses it", async () => {
    const seedData = await seed();
    const resource = await createResource({
      applicationId: seedData.appAId,
      scheme: "gine",
      locator: "project_del",
      displayName: "Project",
      ownerType: "user",
      ownerId: seedData.ownerId,
    });
    await expect(
      deleteApplicationScheme(seedData.appAId, "gine"),
    ).rejects.toMatchObject({ code: "RES_013" });
    await expect(
      deleteApplicationScheme(seedData.appBId, "gine"),
    ).rejects.toMatchObject({ code: "RES_004" });
    await expect(
      deleteApplicationScheme(seedData.appAId, "llm"),
    ).rejects.toMatchObject({ code: "RES_004" });

    await disableResource(resource.id, seedData.ownerId);
    await deleteApplicationScheme(seedData.appAId, "gine");
    const catalog = await listApplicationSchemeCatalog(seedData.appAId);
    expect(catalog.map((entry) => entry.scheme)).not.toContain("gine");
  });

  it("denies a banned account even though its tokens are still valid", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData);
    const decide = () =>
      authorize({
        subjectId: seedData.ownerId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      });
    await expect(decide()).resolves.toMatchObject({ decision: "allow" });

    await db
      .update(userTable)
      .set({ banned: true, banExpires: null })
      .where(eq(userTable.id, seedData.ownerId));
    await expect(decide()).resolves.toEqual({
      decision: "deny",
      reason: "account_disabled",
    });
    await expect(
      listAccessibleResources({ subjectId: seedData.ownerId }),
    ).resolves.toEqual([]);

    await db
      .update(userTable)
      .set({ banExpires: new Date(Date.now() - 60_000) })
      .where(eq(userTable.id, seedData.ownerId));
    await expect(decide()).resolves.toMatchObject({ decision: "allow" });
  });

  it("deletes a never-validated resource and only disables a validated one", async () => {
    const seedData = await seed();
    const pending = await createResource({
      applicationId: seedData.appAId,
      scheme: "gine",
      locator: "never_validated",
      displayName: "Pending",
      ownerType: "user",
      ownerId: seedData.ownerId,
    });
    await expect(
      removeResource(pending.id, seedData.memberId),
    ).rejects.toMatchObject({ code: "RES_002" });
    await expect(
      removeResource(pending.id, seedData.ownerId),
    ).resolves.toMatchObject({ removed: true });
    await expect(getResource(pending.id)).rejects.toMatchObject({
      code: "RES_002",
    });

    const validated = await validatedResource(seedData);
    const result = await removeResource(validated.id, seedData.ownerId);
    expect(result.removed).toBe(false);
    expect(result.resource.status).toBe("disabled");
    await expect(getResource(validated.id)).resolves.toMatchObject({
      status: "disabled",
    });
  });

  it("frees the scheme name when it never had a resource", async () => {
    const seedData = await seed();
    await deleteApplicationScheme(seedData.appAId, "gine");
    await expect(
      createApplicationScheme({
        applicationId: seedData.appAId,
        scheme: "gine",
        displayName: "Again",
      }),
    ).resolves.toMatchObject({ scheme: "gine" });
  });

  it("rejects a validation callback from another scheme validator", async () => {
    const seedData = await seed();
    const resource = await createResource({
      applicationId: seedData.appAId,
      scheme: "gine",
      locator: "project_2",
      displayName: "Project 2",
      ownerType: "user",
      ownerId: seedData.ownerId,
    });
    await expect(
      completeResourceValidation({
        resourceId: resource.id,
        clientId: "litellm",
        result: "validated",
      }),
    ).rejects.toMatchObject({ code: "AUTH_011" });
  });

  it("enforces membership and every grant subject", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData);

    await expect(
      authorize({
        subjectId: seedData.memberId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toEqual({ decision: "deny", reason: "no_grant" });

    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "user",
      subjectId: seedData.memberId,
      actorUserId: seedData.ownerId,
    });
    await expect(
      authorize({
        subjectId: seedData.memberId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toMatchObject({ decision: "allow", accessKind: "grant" });

    const shared = await validatedResource(seedData, {
      ownerType: "application",
    });
    await createResourceGrant({
      resourceId: shared.id,
      subjectType: "organization",
      subjectId: seedData.orgId,
      actorUserId: seedData.adminId,
    });
    await expect(
      authorize({
        subjectId: seedData.orgUserId,
        clientId: "client",
        resourceUri: shared.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toMatchObject({ decision: "allow", grantSubjectType: "organization" });

    await createResourceGrant({
      resourceId: shared.id,
      subjectType: "plan",
      subjectId: seedData.planAId,
      actorUserId: seedData.adminId,
    });
    await expect(
      authorize({
        subjectId: seedData.planUserId,
        clientId: "client",
        resourceUri: shared.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toMatchObject({ decision: "allow", grantSubjectType: "plan" });

    await createResourceGrant({
      resourceId: shared.id,
      subjectType: "everyone",
      subjectId: null,
      actorUserId: seedData.adminId,
    });
    await expect(
      authorize({
        subjectId: "everyone-user",
        clientId: "client",
        resourceUri: shared.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toMatchObject({ decision: "allow", grantSubjectType: "everyone" });

    const outsider = await authorize({
      subjectId: seedData.outsiderId,
      clientId: "client",
      resourceUri: shared.uri,
      audience: "https://auth.example",
    });
    expect(outsider).toEqual({ decision: "deny", reason: "no_membership" });
  });

  it("never admits an administrator to a personal resource, nor lets one grant it", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData);
    await expect(
      authorize({
        subjectId: seedData.adminId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toMatchObject({ decision: "deny" });
    for (const subject of [
      { subjectType: "user", subjectId: seedData.adminId },
      { subjectType: "everyone", subjectId: null },
    ] as const) {
      await expect(
        createResourceGrant({
          resourceId: resource.id,
          ...subject,
          actorUserId: seedData.adminId,
        }),
      ).rejects.toMatchObject({ code: "RES_004" });
    }
    await expect(
      createResourceInvitation({
        email: "invitee@example.com",
        resourceId: resource.id,
        actorUserId: seedData.adminId,
      }),
    ).rejects.toMatchObject({ code: "RES_002" });
    await expect(canManageGrants(seedData.adminId, resource)).resolves.toBe(false);
  });

  it("does not let a guest create or grant resources while it still receives shares", async () => {
    const seedData = await seed();
    const [guestRole] = await db
      .insert(appRoles)
      .values({ applicationId: seedData.appAId, name: "guest" })
      .returning();
    if (!guestRole) throw new Error("role seed failed");
    const resource = await validatedResource(seedData);
    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "user",
      subjectId: seedData.memberId,
      actorUserId: seedData.ownerId,
    });
    await db.insert(userAppRoles).values({
      userId: seedData.memberId,
      applicationId: seedData.appAId,
      roleId: guestRole.id,
    });

    await expect(
      createResource({
        applicationId: seedData.appAId,
        scheme: "gine",
        locator: "guest_project",
        displayName: "Guest project",
        ownerType: "user",
        ownerId: seedData.memberId,
      }),
    ).rejects.toMatchObject({ code: "AUTH_011" });
    await expect(
      authorize({
        subjectId: seedData.memberId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toMatchObject({ decision: "allow", accessKind: "grant" });
  });

  it("does not let a standard owner grant to a non-member or a group", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData);
    await expect(
      createResourceGrant({
        resourceId: resource.id,
        subjectType: "user",
        subjectId: seedData.outsiderId,
        actorUserId: seedData.ownerId,
      }),
    ).rejects.toMatchObject({ code: "RES_004" });
    await expect(
      createResourceGrant({
        resourceId: resource.id,
        subjectType: "everyone",
        subjectId: null,
        actorUserId: seedData.ownerId,
      }),
    ).rejects.toMatchObject({ code: "RES_004" });
  });

  it("separates grant administration from resource administration", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData);
    await db.insert(appDelegations).values([
      {
        userId: "member",
        applicationId: seedData.appAId,
        permission: "grants:manage",
        status: "active",
      },
      {
        userId: "outsider",
        applicationId: seedData.appAId,
        permission: "resources:manage",
        status: "active",
      },
    ]);

    await expect(canManageGrants("owner", resource)).resolves.toBe(true);
    await expect(canManageGrants("member", resource)).resolves.toBe(false);
    await expect(canManageGrants("outsider", resource)).resolves.toBe(false);
    await expect(canManageGrants("admin", resource)).resolves.toBe(false);

    const shared = await validatedResource(seedData, {
      ownerType: "application",
    });
    await expect(canManageGrants("owner", shared)).resolves.toBe(false);
    await expect(canManageGrants("member", shared)).resolves.toBe(true);
    await expect(canManageGrants("outsider", shared)).resolves.toBe(false);
    await expect(canManageGrants("admin", shared)).resolves.toBe(true);
  });

  it("denies when the application disables the scheme or the owner disables the resource", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData);

    await disableSchemeForApplication(seedData.appAId, "gine");
    await expect(
      authorize({
        subjectId: seedData.ownerId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toEqual({ decision: "deny", reason: "scheme_disabled" });

    await enableSchemeForApplication(seedData.appAId, "gine");
    await disableResource(resource.id, seedData.ownerId);
    await expect(
      authorize({
        subjectId: seedData.ownerId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toEqual({ decision: "deny", reason: "disabled" });
  });

  it("denies when the resource application turns sharing off", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData);
    await db
      .update(applications)
      .set({ resourceSharingEnabled: false })
      .where(eq(applications.id, seedData.appAId));

    await expect(
      authorize({
        subjectId: seedData.ownerId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toEqual({ decision: "deny", reason: "sharing_disabled" });
    await expect(
      listAccessibleResources({ subjectId: seedData.ownerId }),
    ).resolves.toEqual([]);
  });

  it("lists accessible resources without leaking foreign grants", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData);
    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "user",
      subjectId: seedData.memberId,
      actorUserId: seedData.ownerId,
    });
    await expect(
      listAccessibleResources({ subjectId: seedData.ownerId }),
    ).resolves.toHaveLength(1);
    await expect(
      listAccessibleResources({ subjectId: seedData.memberId }),
    ).resolves.toHaveLength(1);
    await expect(
      listAccessibleResources({ subjectId: seedData.outsiderId }),
    ).resolves.toEqual([]);
  });

  it("resolves LiteLLM entitlements from linked inventory objects", async () => {
    const seedData = await seed();
    await db.insert(gatewayObjects).values([
      {
        kind: "model",
        litellmId: "gpt-x",
        objectName: "gpt-x",
        parentName: "",
        displayName: "gpt-x",
      },
      {
        kind: "agent",
        litellmId: "agent-1",
        objectName: "analyst",
        parentName: "",
        displayName: "analyst",
      },
      {
        kind: "mcp_server",
        litellmId: "server-1",
        objectName: "server-x",
        parentName: "",
        displayName: "server-x",
      },
      {
        kind: "mcp_tool",
        litellmId: "server-1:search",
        objectName: "search",
        parentName: "server-x",
        displayName: "server-x/search",
      },
    ]);

    for (const [scheme, locator] of [
      ["llm", "app-a/gpt-x"],
      ["agent", "app-a/analyst"],
      ["mcp", "app-a/server-x/tool/search"],
    ] as const) {
      const resource = await createResource({
        applicationId: seedData.appAId,
        scheme,
        locator,
        displayName: locator,
        ownerType: "application",
        ownerId: seedData.appAId,
      });
      await completeResourceValidation({
        resourceId: resource.id,
        clientId: "litellm",
        result: "validated",
      });
      await createResourceGrant({
        resourceId: resource.id,
        subjectType: "everyone",
        subjectId: null,
        actorUserId: seedData.adminId,
      });
    }

    const entitlements = await listGatewayEntitlements(seedData.ownerId);
    expect(entitlements.models).toEqual(["gpt-x"]);
    // LiteLLM's object_permission.agents expects agent ids, not display names.
    expect(entitlements.agents).toEqual(["agent-1"]);
    expect(entitlements.mcpServers).toEqual(["server-x"]);
    expect(entitlements.mcpToolPermissions).toEqual({ "server-x": ["search"] });
    expect(entitlements.resources).toHaveLength(3);
    expect(
      entitlements.resources.map((resource) => resource.uri).sort(),
    ).toEqual([
      "agent://app-a/analyst",
      "llm://app-a/gpt-x",
      "mcp://app-a/server-x/tool/search",
    ]);
  });

  it("keeps a gateway claim the relay did not write pending, whoever makes it", async () => {
    const seedData = await seed();
    await db.insert(gatewayObjects).values({
      kind: "model",
      litellmId: "gpt-x",
      objectName: "gpt-x",
      parentName: "",
      displayName: "gpt-x",
    });
    const claim = (overrides: {
      ownerType: "user" | "application";
      ownerId: string;
      locator: string;
    }) =>
      createResource({
        applicationId: seedData.appAId,
        scheme: "llm",
        displayName: "gpt-x",
        ...overrides,
      });
    const memberClaim = await claim({
      ownerType: "user",
      ownerId: seedData.ownerId,
      locator: "app-a/gpt-x",
    });
    expect(memberClaim.status).toBe("pending_validation");
    await expect(
      claim({
        ownerType: "application",
        ownerId: seedData.appAId,
        locator: "other-app/gpt-x",
      }),
    ).rejects.toMatchObject({ code: "RES_005" });
    await expect(
      listGatewayEntitlements(seedData.ownerId),
    ).resolves.toMatchObject({ models: [], resources: [] });
  });

  it("parses inventory targets from resource locators", () => {
    expect(gatewayTargetForResource("llm", "acme/gpt-x")).toEqual({
      kind: "model",
      name: "gpt-x",
      parentName: "",
    });
    expect(gatewayTargetForResource("agent", "acme/analyst")).toEqual({
      kind: "agent",
      name: "analyst",
      parentName: "",
    });
    expect(gatewayTargetForResource("mcp", "acme/server-x")).toEqual({
      kind: "mcp_server",
      name: "server-x",
      parentName: "",
    });
    expect(
      gatewayTargetForResource("mcp", "acme/server-x/tool/search"),
    ).toEqual({
      kind: "mcp_tool",
      name: "search",
      parentName: "server-x",
    });
    expect(gatewayTargetForResource("gine", "project")).toBeNull();
  });

  it("redeems an invitation for an existing AuthService account", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData, {
      ownerType: "application",
    });
    const created = await createResourceInvitation({
      email: "invitee@example.com",
      resourceId: resource.id,
      actorUserId: seedData.adminId,
    });
    await seedUser("invitee");
    const grant = await acceptResourceInvitation({
      token: created.token,
      subjectId: "invitee",
      email: "invitee@example.com",
      emailVerified: true,
    });
    expect(grant.subjectId).toBe("invitee");
    const [membership] = await db
      .select({ id: userApplications.id })
      .from(userApplications)
      .where(
        eq(userApplications.userId, "invitee"),
      );
    expect(membership).toBeDefined();
    const active = await resolveGrantsForSubject("invitee", resource.id);
    expect(active).toHaveLength(1);
  });

  it("keeps member emails from a delegate who does not administer the application", async () => {
    const seedData = await seed();
    await db.insert(appDelegations).values({
      userId: "member",
      applicationId: seedData.appAId,
      permission: "resources:read",
      status: "active",
    });
    const page = { limit: 10, offset: 0 };
    const asAdmin = await listOwnerMembers(seedData.appAId, page, "admin");
    const asDelegate = await listOwnerMembers(seedData.appAId, page, "member");
    expect(asAdmin.members.every((entry) => entry.email !== null)).toBe(true);
    expect(asDelegate.members).toHaveLength(asAdmin.members.length);
    expect(asDelegate.members.every((entry) => entry.email === null)).toBe(
      true,
    );
  });

  it("keeps a suspended membership suspended through an invitation or an add-member call", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData, {
      ownerType: "application",
    });
    const created = await createResourceInvitation({
      email: "invitee@example.com",
      resourceId: resource.id,
      actorUserId: seedData.adminId,
    });
    await seedUser("invitee");
    await db.insert(userApplications).values({
      userId: "invitee",
      applicationId: seedData.appAId,
      isActive: false,
    });

    await expect(
      acceptResourceInvitation({
        token: created.token,
        subjectId: "invitee",
        email: "invitee@example.com",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "RES_004" });
    await expect(
      addExistingUserToApplication(
        seedData.adminId,
        seedData.appAId,
        "invitee@example.com",
      ),
    ).resolves.toBeNull();
    await expect(
      addExistingUserToApplication(
        seedData.adminId,
        seedData.appAId,
        "nobody@example.com",
      ),
    ).resolves.toBeNull();

    const [membership] = await db
      .select({ isActive: userApplications.isActive })
      .from(userApplications)
      .where(eq(userApplications.userId, "invitee"));
    expect(membership?.isActive).toBe(false);
    await expect(
      resolveGrantsForSubject("invitee", resource.id),
    ).resolves.toHaveLength(0);

    await seedUser("newcomer");
    await expect(
      addExistingUserToApplication(
        seedData.adminId,
        seedData.appAId,
        "newcomer@example.com",
      ),
    ).resolves.toMatchObject({ email: "newcomer@example.com" });
  });

  it("records usage idempotently and aggregates it per application", async () => {
    const seedData = await seed();
    const resource = await validatedResource(seedData);
    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "user",
      subjectId: seedData.memberId,
      actorUserId: seedData.ownerId,
    });
    const event = {
      subjectId: seedData.memberId,
      clientId: "client-1",
      resourceId: resource.id,
      resourceUri: resource.uri,
      requestId: "a".repeat(64),
      occurredAt: new Date("2026-11-15T12:00:00.000Z"),
      usageSource: "provider" as const,
      costUsd: "0.25",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    };
    const first = await recordUsageEvent(event);
    expect(first.replayed).toBe(false);
    const replay = await recordUsageEvent(event);
    expect(replay.replayed).toBe(true);

    const usage = await getApplicationUsage(seedData.appAId, {
      groupBy: "resource",
      from: new Date("2026-11-01T00:00:00.000Z"),
      to: new Date("2026-12-01T00:00:00.000Z"),
      limit: 10,
      offset: 0,
    });
    expect(usage.totals.calls).toBe(1);
    expect(usage.totals.costUsd).toBe("0.25");
  });

  it("stores access events and purges them past retention", async () => {
    const seedData = await seed();
    await recordAccessEvent({
      uri: "gine://project_1",
      scheme: "gine",
      subjectType: "user",
      subjectId: seedData.memberId,
      clientId: "client",
      applicationId: seedData.appAId,
      decision: "deny",
      reasonClass: "no_grant",
      source: "gateway",
    });
    await expect(
      listAccessEvents({ applicationId: seedData.appAId, limit: 10, offset: 0 }),
    ).resolves.toHaveLength(1);

    await db.insert(resources).values({
      id: "00000000-0000-0000-0000-000000000001",
      applicationId: seedData.appAId,
      scheme: "gine",
      locator: "old",
      uri: "gine://old",
      displayName: "Old",
      ownerType: "user",
      ownerId: seedData.ownerId,
      status: "validated",
    });
    const future = new Date(Date.now() + 401 * 24 * 60 * 60 * 1000);
    const result = await sweepResourceMonitoringRetention(future);
    expect(result.accessEvents).toBeGreaterThanOrEqual(1);
    await expect(
      listAccessEvents({ applicationId: seedData.appAId, limit: 10, offset: 0 }),
    ).resolves.toHaveLength(0);
  });
});
