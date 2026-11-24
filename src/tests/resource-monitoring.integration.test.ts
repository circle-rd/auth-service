import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import {
  applications,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
  userApplications,
} from "../db/schema.js";
import { user as userTable } from "../db/auth-schema.js";
import { resourceUsageRecords } from "../db/resource-schema.js";
import { getBusinessStats } from "../services/billing/mrr.js";
import {
  createApplicationScheme,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import { createResource } from "../services/resources/registry.js";
import {
  getSecurityStats,
  getUserActivity,
  listAdminAccessEvents,
} from "../services/resources/monitoring.js";
import { recordAccessEvent } from "../services/resources/usage.js";
import { cleanDb } from "./helpers/db.js";

async function seedUser(id: string): Promise<void> {
  await db.insert(userTable).values({
    id,
    name: `User ${id}`,
    email: `${id}@example.com`,
    emailVerified: true,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seed() {
  const [app] = await db
    .insert(applications)
    .values({
      name: "App A",
      slug: "app-a",
      isActive: true,
      resourceSharingEnabled: true,
    })
    .returning();
  if (!app) throw new Error("application seed failed");
  await seedUser("owner");
  await seedUser("guest");
  await db.insert(userApplications).values([
    { userId: "owner", applicationId: app.id, isActive: true },
    { userId: "guest", applicationId: app.id, isActive: true },
  ]);
  await syncBuiltinSchemes();
  await createApplicationScheme({
    applicationId: app.id,
    scheme: "gine",
    displayName: "Projet",
  });
  const resource = await createResource({
    applicationId: app.id,
    scheme: "gine",
    locator: "project_1",
    displayName: "Project 1",
    ownerType: "user",
    ownerId: "owner",
  });
  return { appId: app.id, resource };
}

async function usage(
  seeded: Awaited<ReturnType<typeof seed>>,
  subjectId: string,
  totalTokens: number,
  costUsd: string,
) {
  await db.insert(resourceUsageRecords).values({
    occurredAt: new Date(),
    resourceId: seeded.resource.id,
    uri: seeded.resource.uri,
    scheme: "gine",
    ownerType: "user",
    ownerId: "owner",
    subjectType: "user",
    subjectId,
    clientId: "client",
    applicationId: seeded.appId,
    requestId: `${subjectId}-${totalTokens}-${Math.random()}`,
    promptTokens: totalTokens,
    completionTokens: 0,
    totalTokens,
    costUsd,
    usageSource: "provider",
  });
}

async function event(
  seeded: Awaited<ReturnType<typeof seed>>,
  subjectId: string,
  decision: "allow" | "deny",
  reasonClass: string | null = null,
) {
  await recordAccessEvent({
    resourceId: seeded.resource.id,
    uri: seeded.resource.uri,
    scheme: "gine",
    ownerType: "user",
    ownerId: "owner",
    subjectType: "user",
    subjectId,
    clientId: "client",
    applicationId: seeded.appId,
    decision,
    reasonClass,
    source: "gateway",
  });
}

beforeEach(async () => {
  await cleanDb();
});

describe("resource monitoring", () => {
  it("summarises resources, grants and decisions for the security view", async () => {
    const seeded = await seed();
    await event(seeded, "guest", "allow");
    await event(seeded, "guest", "allow");
    await event(seeded, "guest", "deny", "no_grant");

    const stats = await getSecurityStats("7d");
    expect(stats.resources.total).toBe(1);
    expect(stats.resources.byStatus).toEqual([
      { status: "pending_validation", count: 1 },
    ]);
    expect(stats.access).toMatchObject({ allow: 2, deny: 1 });
    expect(stats.access.series).toHaveLength(7);
    expect(stats.access.topDeniedReasons).toEqual([
      { reason: "no_grant", count: 1 },
    ]);
    expect(stats.access.topResources[0]).toMatchObject({
      uri: "gine://project_1",
      calls: 3,
      denies: 1,
    });
    expect(stats.access.topSubjects[0]).toMatchObject({
      subjectId: "guest",
      name: "User guest",
      calls: 3,
    });
  });

  it("pages the admin activity log and filters on the decision", async () => {
    const seeded = await seed();
    await event(seeded, "guest", "allow");
    await event(seeded, "guest", "deny", "no_grant");

    const all = await listAdminAccessEvents({ limit: 1, offset: 0 });
    expect(all.events).toHaveLength(1);
    expect(all.hasMore).toBe(true);
    expect(all.nextOffset).toBe(1);

    const denied = await listAdminAccessEvents({
      decision: "deny",
      limit: 10,
      offset: 0,
    });
    expect(denied.events).toHaveLength(1);
    expect(denied.events[0]).toMatchObject({
      decision: "deny",
      subjectName: "User guest",
    });
    expect(denied.hasMore).toBe(false);
  });

  it("counts usage on shared resources without exposing other users", async () => {
    const seeded = await seed();
    await usage(seeded, "guest", 15, "0.25");
    await usage(seeded, "guest", 5, "0.15");
    await usage(seeded, "owner", 7, "0.1");
    await event(seeded, "guest", "deny", "no_grant");

    const owner = await getUserActivity("owner", seeded.appId, "7d");
    expect(owner.shared).toMatchObject({
      allow: 2,
      deny: 1,
      totalTokens: 20,
      costUsd: "0.40",
    });
    expect(owner.shared.topResources[0]).toMatchObject({
      uri: "gine://project_1",
      calls: 2,
    });
    expect(owner.shared).not.toHaveProperty("topSubjects");
    expect(owner.shared).not.toHaveProperty("recent");
    expect(owner.used.calls).toBe(1);

    const guest = await getUserActivity("guest", seeded.appId, "7d");
    expect(guest.shared).toMatchObject({ allow: 0, deny: 0 });
    expect(guest.used).toMatchObject({ calls: 2, totalTokens: 20, costUsd: "0.40" });
  });

  it("estimates MRR from Stripe-managed subscriptions only", async () => {
    const seeded = await seed();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({ applicationId: seeded.appId, name: "Team", features: {} })
      .returning();
    if (!plan) throw new Error("plan seed failed");
    await db.insert(subscriptionPlanPrices).values({
      planId: plan.id,
      name: "Monthly",
      amount: "1500",
      currency: "eur",
      interval: "month",
    });
    await db.insert(userSubscriptions).values([
      {
        userId: "owner",
        applicationId: seeded.appId,
        planId: plan.id,
        isActive: true,
        stripeSubscriptionId: "sub_1",
      },
      {
        userId: "guest",
        applicationId: seeded.appId,
        planId: plan.id,
        isActive: true,
      },
    ]);

    const stats = await getBusinessStats();
    expect(stats).toMatchObject({
      currency: "eur",
      mrr: 1500,
      arr: 18000,
      payingSubscriptions: 1,
      unpricedSubscriptions: 0,
    });
    expect(stats.byPlan[0]).toMatchObject({ planName: "Team", count: 1, mrr: 1500 });
  });
});
