import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  applications,
  subscriptionPlans,
  userApplications,
  userSubscriptions,
} from "../db/schema.js";
import { gatewayObjects, resourceGatewayLinks } from "../db/gateway-schema.js";
import { resourceGrants, resources } from "../db/resource-schema.js";
import { recordUsageEvent } from "../services/resources/usage.js";
import { listGatewayEntitlements } from "../services/gateway-inventory.js";
import { user as userTable } from "../db/auth-schema.js";
import { listAccessibleResources } from "../services/resources/access.js";
import {
  createResourceGrant,
  revokeResourceGrant,
} from "../services/resources/grants.js";
import { shareResourcesWithApplication } from "../services/resources/application-sharing.js";
import { listGrantsForResource } from "../services/resources/grant-views.js";
import { authorize } from "../services/resources/policy.js";
import { getResource } from "../services/resources/registry.js";
import {
  enableSchemeForApplication,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import { cleanDb } from "./helpers/db.js";

interface Seed {
  ownerAppId: string;
  consumerAppId: string;
  otherAppId: string;
  resourceId: string;
  resourceUri: string;
  planId: string;
}

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

async function seedApp(slug: string, overrides: { isActive?: boolean } = {}) {
  const [app] = await db
    .insert(applications)
    .values({
      name: slug,
      slug,
      isActive: overrides.isActive ?? true,
      resourceSharingEnabled: true,
    })
    .returning();
  if (!app) throw new Error("application seed failed");
  return app;
}

async function seed(): Promise<Seed> {
  // `file` is the built-in scheme that supports both levels.
  Object.assign(config.resources, {
    enabledSchemes: [...new Set([...config.resources.enabledSchemes, "file"])],
  });
  await syncBuiltinSchemes();
  const ownerApp = await seedApp("owner-app");
  const consumerApp = await seedApp("consumer-app");
  const otherApp = await seedApp("other-app");
  // Application-defined schemes stay private to their application, so only a
  // built-in scheme can cross applications.
  await enableSchemeForApplication(ownerApp.id, "file");
  await enableSchemeForApplication(consumerApp.id, "file");

  for (const id of ["owner", "reader", "planner", "stranger"]) {
    await seedUser(id);
  }
  const memberships: Array<[string, string]> = [
    ["owner", ownerApp.id],
    ["owner", consumerApp.id],
    ["reader", ownerApp.id],
    ["reader", consumerApp.id],
    ["planner", ownerApp.id],
    ["planner", consumerApp.id],
    ["stranger", otherApp.id],
  ];
  for (const [userId, applicationId] of memberships) {
    await db
      .insert(userApplications)
      .values({ userId, applicationId, isActive: true });
  }
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: ownerApp.id, name: "team", features: {} })
    .returning();
  if (!plan) throw new Error("plan seed failed");
  await db.insert(userSubscriptions).values({
    userId: "planner",
    applicationId: ownerApp.id,
    planId: plan.id,
    isActive: true,
  });

  const [created] = await db
    .insert(resources)
    .values({
      applicationId: ownerApp.id,
      scheme: "file",
      locator: "/doc_1",
      uri: "file:///doc_1",
      displayName: "Document",
      ownerType: "user",
      ownerId: "owner",
      status: "validated",
    })
    .returning();
  if (!created) throw new Error("resource seed failed");
  const resource = await getResource(created.id);
  return {
    ownerAppId: ownerApp.id,
    consumerAppId: consumerApp.id,
    otherAppId: otherApp.id,
    resourceId: resource.id,
    resourceUri: resource.uri,
    planId: plan.id,
  };
}

function ask(
  data: Seed,
  via: "owner" | "consumer" | "other",
  subjectId: string,
  permission?: "read" | "write",
  audience: string = config.betterAuth.url,
) {
  const caller = {
    owner: { id: data.ownerAppId, slug: "owner-app" },
    consumer: { id: data.consumerAppId, slug: "consumer-app" },
    other: { id: data.otherAppId, slug: "other-app" },
  }[via];
  return authorize({
    subjectId,
    caller,
    resourceUri: data.resourceUri,
    audience,
    permission,
  });
}

async function shareWithConsumer(
  data: Seed,
  permission: "read" | "write" = "read",
) {
  return createResourceGrant({
    resourceId: data.resourceId,
    subjectType: "application",
    subjectId: "consumer-app",
    actorUserId: "owner",
    permission,
  });
}

beforeEach(async () => {
  await cleanDb();
});

describe("application scope", () => {
  it("keeps a resource inside its owner application until it is shared", async () => {
    const data = await seed();
    await expect(ask(data, "owner", "owner")).resolves.toMatchObject({
      decision: "allow",
      permission: "write",
    });
    await expect(ask(data, "consumer", "owner")).resolves.toEqual({
      decision: "deny",
      reason: "not_in_scope",
    });
    await expect(ask(data, "other", "stranger")).resolves.toEqual({
      decision: "deny",
      reason: "not_in_scope",
    });
  });

  it("opens the resource to the application the owner shared it with", async () => {
    const data = await seed();
    await shareWithConsumer(data);
    await expect(ask(data, "consumer", "owner")).resolves.toMatchObject({
      decision: "allow",
      accessKind: "owner",
    });
    await expect(ask(data, "other", "owner")).resolves.toMatchObject({
      decision: "deny",
      reason: "not_in_scope",
    });
  });

  it("caps the person's level at the application's level", async () => {
    const data = await seed();
    await shareWithConsumer(data, "read");
    await expect(ask(data, "consumer", "owner")).resolves.toMatchObject({
      decision: "allow",
      permission: "read",
    });
    await expect(ask(data, "consumer", "owner", "write")).resolves.toEqual({
      decision: "deny",
      reason: "insufficient_permission",
    });
    await expect(ask(data, "owner", "owner", "write")).resolves.toMatchObject({
      decision: "allow",
    });
  });

  it("never lets an application grant widen the person's own right", async () => {
    const data = await seed();
    await shareWithConsumer(data, "write");
    await expect(ask(data, "consumer", "reader")).resolves.toEqual({
      decision: "deny",
      reason: "no_grant",
    });
    await createResourceGrant({
      resourceId: data.resourceId,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "owner",
      permission: "read",
    });
    await expect(ask(data, "consumer", "reader")).resolves.toMatchObject({
      decision: "allow",
      permission: "read",
    });
    await expect(ask(data, "consumer", "reader", "write")).resolves.toEqual({
      decision: "deny",
      reason: "insufficient_permission",
    });
  });

  it("checks membership in the calling application, not the owner one", async () => {
    const data = await seed();
    await shareWithConsumer(data);
    await db
      .update(userApplications)
      .set({ isActive: false })
      .where(
        // The owner stays in the owner application only.
        eq(userApplications.applicationId, data.consumerAppId),
      );
    await expect(ask(data, "consumer", "owner")).resolves.toEqual({
      decision: "deny",
      reason: "no_membership",
    });
    await expect(ask(data, "owner", "owner")).resolves.toMatchObject({
      decision: "allow",
    });
  });

  it("stops at a revoked or expired application grant", async () => {
    const data = await seed();
    const grant = await shareWithConsumer(data);
    await revokeResourceGrant(grant.id, "owner");
    await expect(ask(data, "consumer", "owner")).resolves.toMatchObject({
      decision: "deny",
      reason: "not_in_scope",
    });

    await shareWithConsumer(data);
    await db
      .update(resourceGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(resourceGrants.resourceId, data.resourceId),
          isNull(resourceGrants.revokedAt),
        ),
      );
    await expect(ask(data, "consumer", "owner")).resolves.toMatchObject({
      decision: "deny",
      reason: "not_in_scope",
    });
  });

  it("counts plan grants only through the application that owns the resource", async () => {
    const data = await seed();
    await shareWithConsumer(data);
    await db.insert(resourceGrants).values({
      resourceId: data.resourceId,
      subjectType: "plan",
      subjectId: data.planId,
      permission: "read",
      createdBy: "owner",
    });
    await expect(ask(data, "owner", "planner")).resolves.toMatchObject({
      decision: "allow",
    });
    await expect(ask(data, "consumer", "planner")).resolves.toEqual({
      decision: "deny",
      reason: "no_grant",
    });
  });
});

describe("caller checks", () => {
  it("denies a client that is not an active sharing application", async () => {
    const data = await seed();
    await db
      .update(applications)
      .set({ isActive: false })
      .where(eq(applications.id, data.consumerAppId));
    await expect(ask(data, "consumer", "owner")).resolves.toEqual({
      decision: "deny",
      reason: "invalid_client",
    });
    await expect(
      authorize({
        subjectId: "owner",
        caller: { id: data.ownerAppId, slug: "not-its-slug" },
        resourceUri: data.resourceUri,
        audience: config.betterAuth.url,
      }),
    ).resolves.toEqual({ decision: "deny", reason: "invalid_client" });
  });

  it("accepts the issuer or an allowed resource as audience, nothing else", async () => {
    const data = await seed();
    const issuer = config.betterAuth.url;
    await expect(
      ask(data, "owner", "owner", undefined, `${issuer}/`),
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      ask(data, "owner", "owner", undefined, "https://evil.example"),
    ).resolves.toEqual({ decision: "deny", reason: "invalid_audience" });

    await db
      .update(applications)
      .set({ allowedResources: ["https://gateway.example"] })
      .where(eq(applications.id, data.ownerAppId));
    await expect(
      ask(data, "owner", "owner", undefined, "https://gateway.example"),
    ).resolves.toMatchObject({ decision: "allow" });
  });
});

describe("application grant targets", () => {
  it("refuses an inactive target, the owner application and a disabled scheme", async () => {
    const data = await seed();
    await db
      .update(applications)
      .set({ isActive: false })
      .where(eq(applications.id, data.otherAppId));
    for (const subjectId of ["other-app", "owner-app", "missing-app"]) {
      await expect(
        createResourceGrant({
          resourceId: data.resourceId,
          subjectType: "application",
          subjectId,
          actorUserId: "owner",
        }),
      ).rejects.toMatchObject({ code: "RES_001" });
    }
    await db
      .update(applications)
      .set({ isActive: true })
      .where(eq(applications.id, data.otherAppId));
    // The scheme is not enabled for that application.
    await expect(
      createResourceGrant({
        resourceId: data.resourceId,
        subjectType: "application",
        subjectId: "other-app",
        actorUserId: "owner",
      }),
    ).rejects.toMatchObject({ code: "RES_001" });
  });
});

describe("accessible listing by application", () => {
  it("returns only the caller's scope and hides the owner from a foreign application", async () => {
    const data = await seed();
    const asOwnerApp = await listAccessibleResources({
      subjectId: "owner",
      caller: { id: data.ownerAppId, slug: "owner-app" },
    });
    expect(asOwnerApp).toHaveLength(1);
    expect(asOwnerApp[0]).toMatchObject({ ownerId: "owner", permission: "write" });

    expect(
      await listAccessibleResources({
        subjectId: "owner",
        caller: { id: data.consumerAppId, slug: "consumer-app" },
      }),
    ).toEqual([]);

    await shareWithConsumer(data);
    const asConsumer = await listAccessibleResources({
      subjectId: "owner",
      caller: { id: data.consumerAppId, slug: "consumer-app" },
    });
    expect(asConsumer).toHaveLength(1);
    expect(asConsumer[0]).toMatchObject({
      resourceId: data.resourceId,
      permission: "read",
    });
    expect(asConsumer[0]).not.toHaveProperty("ownerId");

    const global = await listAccessibleResources({ subjectId: "owner" });
    expect(global).toHaveLength(1);
    expect(global[0]).toHaveProperty("ownerId", "owner");
  });
});

describe("sharing with an application", () => {
  it("shares several resources and reports each refusal on its own", async () => {
    const data = await seed();
    const [foreign] = await db
      .insert(resources)
      .values({
        applicationId: data.ownerAppId,
        scheme: "file",
        locator: "/doc_2",
        uri: "file:///doc_2",
        displayName: "Someone else's document",
        ownerType: "user",
        ownerId: "reader",
        status: "validated",
      })
      .returning();
    if (!foreign) throw new Error("resource seed failed");

    const first = await shareResourcesWithApplication({
      resourceIds: [data.resourceId, foreign.id],
      applicationSlug: "consumer-app",
      permission: "read",
      actorUserId: "owner",
    });
    expect(first[0]).toMatchObject({ resourceId: data.resourceId, code: null });
    expect(first[0]?.grantId).toEqual(expect.any(String));
    expect(first[1]).toEqual({
      resourceId: foreign.id,
      grantId: null,
      code: "RES_004",
    });

    const again = await shareResourcesWithApplication({
      resourceIds: [data.resourceId],
      applicationSlug: "consumer-app",
      actorUserId: "owner",
    });
    expect(again[0]?.code).toBe("RES_008");
  });

  it("shows the application by name in the grant list", async () => {
    const data = await seed();
    await shareWithConsumer(data);
    const grants = await listGrantsForResource(data.resourceId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      subjectType: "application",
      subjectId: "consumer-app",
      subjectLabel: "consumer-app",
    });
  });
});

describe("gateway entitlements by application", () => {
  it("serves a model to the application it was shared with, and to no other", async () => {
    await seed();
    await syncBuiltinSchemes();
    const [owner] = await db
      .select()
      .from(applications)
      .where(eq(applications.slug, "owner-app"));
    const [consumer] = await db
      .select()
      .from(applications)
      .where(eq(applications.slug, "consumer-app"));
    if (!owner || !consumer) throw new Error("seed missing");
    await enableSchemeForApplication(owner.id, "llm");
    await enableSchemeForApplication(consumer.id, "llm");
    const [object] = await db
      .insert(gatewayObjects)
      .values({
        kind: "model",
        litellmId: "u-owner/qwen",
        objectName: "u-owner/qwen",
        parentName: "",
        displayName: "u-owner/qwen",
      })
      .returning();
    const [model] = await db
      .insert(resources)
      .values({
        applicationId: owner.id,
        scheme: "llm",
        locator: "owner-app/qwen",
        uri: "llm://owner-app/qwen",
        displayName: "qwen",
        ownerType: "user",
        ownerId: "owner",
        status: "validated",
      })
      .returning();
    if (!object || !model) throw new Error("seed failed");
    await db
      .insert(resourceGatewayLinks)
      .values({ resourceId: model.id, gatewayObjectId: object.id });

    const through = (app: typeof owner) => ({ id: app.id, slug: app.slug });
    const ownerView = await listGatewayEntitlements("owner", through(owner));
    expect(ownerView.models).toEqual(["u-owner/qwen"]);

    expect(
      (await listGatewayEntitlements("owner", through(consumer))).models,
    ).toEqual([]);

    await createResourceGrant({
      resourceId: model.id,
      subjectType: "application",
      subjectId: "consumer-app",
      actorUserId: "owner",
    });
    const shared = await listGatewayEntitlements("owner", through(consumer));
    expect(shared.models).toEqual(["u-owner/qwen"]);
    expect(shared.resources[0]).not.toHaveProperty("ownerId");
    expect(shared.resources[0]).toMatchObject({ ownerType: "user" });
  });
});

describe("usage recorded through an application", () => {
  it("accepts usage only from an application inside the resource's scope", async () => {
    const data = await seed();
    const event = (caller: { id: string; slug: string }, requestId: string) => ({
      subjectId: "owner",
      caller,
      resourceId: data.resourceId,
      resourceUri: data.resourceUri,
      requestId,
      occurredAt: new Date(),
      usageSource: "unsupported" as const,
      costUsd: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
    const consumer = { id: data.consumerAppId, slug: "consumer-app" };
    await expect(
      recordUsageEvent(event(consumer, "a".repeat(64))),
    ).rejects.toMatchObject({ code: "RES_011" });

    await shareWithConsumer(data);
    const recorded = await recordUsageEvent(event(consumer, "b".repeat(64)));
    expect(recorded.record.clientId).toBe("consumer-app");
    expect(recorded.record.applicationId).toBe(data.ownerAppId);
  });
});
