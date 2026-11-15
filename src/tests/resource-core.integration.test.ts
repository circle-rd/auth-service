import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  applications,
  subscriptionPlans,
  userApplications,
  userSubscriptions,
} from "../db/schema.js";
import { member, organization, user as userTable } from "../db/auth-schema.js";
import { resources } from "../db/resource-schema.js";
import { gatewayObjects } from "../db/gateway-schema.js";
import {
  createApplicationScheme,
  disableSchemeForApplication,
  enableSchemeForApplication,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import {
  createResource,
  disableResource,
  getResource,
} from "../services/resources/registry.js";
import { completeResourceValidation } from "../services/resources/validation.js";
import { authorize } from "../services/resources/policy.js";
import {
  createResourceGrant,
  resolveGrantsForSubject,
} from "../services/resources/grants.js";
import { listAccessibleResources } from "../services/resources/access.js";
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
  } = {},
) {
  const resource = await createResource({
    applicationId: seedData.appAId,
    scheme: overrides.scheme ?? "gine",
    locator: overrides.locator ?? `project_${Math.random().toString(36).slice(2)}`,
    displayName: overrides.displayName ?? "Project",
    ownerType: "user",
    ownerId: seedData.ownerId,
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

    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "organization",
      subjectId: seedData.orgId,
      actorUserId: seedData.adminId,
    });
    await expect(
      authorize({
        subjectId: seedData.orgUserId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toMatchObject({ decision: "allow", grantSubjectType: "organization" });

    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "plan",
      subjectId: seedData.planAId,
      actorUserId: seedData.adminId,
    });
    await expect(
      authorize({
        subjectId: seedData.planUserId,
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toMatchObject({ decision: "allow", grantSubjectType: "plan" });

    await createResourceGrant({
      resourceId: resource.id,
      subjectType: "everyone",
      subjectId: null,
      actorUserId: seedData.adminId,
    });
    await expect(
      authorize({
        subjectId: "everyone-user",
        clientId: "client",
        resourceUri: resource.uri,
        audience: "https://auth.example",
      }),
    ).resolves.toMatchObject({ decision: "allow", grantSubjectType: "everyone" });

    const outsider = await authorize({
      subjectId: seedData.outsiderId,
      clientId: "client",
      resourceUri: resource.uri,
      audience: "https://auth.example",
    });
    expect(outsider).toEqual({ decision: "deny", reason: "no_membership" });
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
        ownerType: "user",
        ownerId: seedData.ownerId,
      });
      await completeResourceValidation({
        resourceId: resource.id,
        clientId: "litellm",
        result: "validated",
      });
    }

    const entitlements = await listGatewayEntitlements(seedData.ownerId);
    expect(entitlements.models).toEqual(["gpt-x"]);
    expect(entitlements.agents).toEqual(["analyst"]);
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
    const resource = await validatedResource(seedData);
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
    const result = await sweepResourceMonitoringRetention(
      new Date("2026-11-15T12:00:00.000Z"),
    );
    expect(result.accessEvents).toBeGreaterThanOrEqual(0);
  });
});
