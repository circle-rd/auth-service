import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  applications,
  subscriptionPlans,
  userApplications,
  userSubscriptions,
} from "../db/schema.js";
import {
  resourceGrants,
  resourceWebhookDeliveries,
  resources,
} from "../db/resource-schema.js";
import { user as userTable } from "../db/auth-schema.js";
import {
  createResourceGrant,
  revokeResourceGrant,
  updateResourceGrantPermission,
} from "../services/resources/grants.js";
import {
  enableSchemeForApplication,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import { encryptResourceWebhookSecret } from "../services/resources/webhooks.js";
import { cleanDb } from "./helpers/db.js";

interface Seed {
  resourceId: string;
  planId: string;
  ids: Record<"owner-app" | "consumer-app" | "other-app", string>;
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

async function seed(): Promise<Seed> {
  Object.assign(config.resources, {
    enabledSchemes: [...new Set([...config.resources.enabledSchemes, "file"])],
  });
  await syncBuiltinSchemes();
  const ids = {} as Seed["ids"];
  for (const slug of ["owner-app", "consumer-app", "other-app"] as const) {
    const [app] = await db
      .insert(applications)
      .values({
        name: slug,
        slug,
        isActive: true,
        resourceSharingEnabled: true,
        resourceWebhookUrl: `https://${slug}.example/hook`,
        resourceWebhookSecret: encryptResourceWebhookSecret(`secret-${slug}`),
      })
      .returning();
    if (!app) throw new Error("application seed failed");
    ids[slug] = app.id;
  }
  await enableSchemeForApplication(ids["owner-app"], "file");
  await enableSchemeForApplication(ids["consumer-app"], "file");

  for (const id of ["owner", "inside", "outside", "planner"]) await seedUser(id);
  const memberships: Array<[string, string]> = [
    ["owner", "owner-app"],
    ["owner", "consumer-app"],
    ["inside", "owner-app"],
    ["inside", "consumer-app"],
    ["outside", "owner-app"],
    ["planner", "owner-app"],
  ];
  for (const [userId, slug] of memberships) {
    await db
      .insert(userApplications)
      .values({ userId, applicationId: ids[slug as keyof Seed["ids"]], isActive: true });
  }
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: ids["owner-app"], name: "team", features: {} })
    .returning();
  if (!plan) throw new Error("plan seed failed");
  await db.insert(userSubscriptions).values({
    userId: "planner",
    applicationId: ids["owner-app"],
    planId: plan.id,
    isActive: true,
  });
  const [resource] = await db
    .insert(resources)
    .values({
      applicationId: ids["owner-app"],
      scheme: "file",
      locator: "/doc_1",
      uri: "file:///doc_1",
      displayName: "Document",
      ownerType: "user",
      ownerId: "owner",
      status: "validated",
    })
    .returning();
  if (!resource) throw new Error("resource seed failed");
  return { resourceId: resource.id, planId: plan.id, ids };
}

async function deliveries(data: Seed) {
  const rows = await db.select().from(resourceWebhookDeliveries);
  const slugOf = new Map(
    Object.entries(data.ids).map(([slug, id]) => [id, slug]),
  );
  return rows.map((row) => ({
    to: slugOf.get(row.applicationId),
    type: row.eventType,
    payload: row.payload as {
      resource: Record<string, unknown>;
      grant: Record<string, unknown>;
      recipients: { userIds: string[] | null; allMembers: boolean };
    },
  }));
}

beforeEach(async () => {
  await cleanDb();
});

describe("resource webhooks across applications", () => {
  it("tells the owner and the application it was shared with, nobody else", async () => {
    const data = await seed();
    await createResourceGrant({
      resourceId: data.resourceId,
      subjectType: "application",
      subjectId: "consumer-app",
      actorUserId: "owner",
    });
    const sent = await deliveries(data);
    expect(sent.map((d) => d.to).sort()).toEqual(["consumer-app", "owner-app"]);
    for (const delivery of sent) {
      expect(delivery.type).toBe("resource.grant.created");
      expect(delivery.payload.grant).toMatchObject({
        subjectType: "application",
        subjectId: "consumer-app",
        permission: "read",
      });
      expect(delivery.payload.recipients.allMembers).toBe(true);
    }
  });

  it("keeps the owner's identity inside the owner application", async () => {
    const data = await seed();
    await createResourceGrant({
      resourceId: data.resourceId,
      subjectType: "application",
      subjectId: "consumer-app",
      actorUserId: "owner",
    });
    const sent = await deliveries(data);
    const toOwner = sent.find((d) => d.to === "owner-app");
    const toConsumer = sent.find((d) => d.to === "consumer-app");
    expect(toOwner?.payload.resource).toHaveProperty("ownerId", "owner");
    expect(toConsumer?.payload.resource).not.toHaveProperty("ownerId");
    expect(toConsumer?.payload.resource).toHaveProperty("ownerType", "user");
  });

  it("shows another application only the grants that concern its own members", async () => {
    const data = await seed();
    await createResourceGrant({
      resourceId: data.resourceId,
      subjectType: "application",
      subjectId: "consumer-app",
      actorUserId: "owner",
    });
    await db.delete(resourceWebhookDeliveries);

    await createResourceGrant({
      resourceId: data.resourceId,
      subjectType: "user",
      subjectId: "inside",
      actorUserId: "owner",
    });
    await createResourceGrant({
      resourceId: data.resourceId,
      subjectType: "user",
      subjectId: "outside",
      actorUserId: "owner",
    });
    // An owner cannot grant a plan, so the row is written directly.
    await db.insert(resourceGrants).values({
      resourceId: data.resourceId,
      subjectType: "plan",
      subjectId: data.planId,
      createdBy: "owner",
    });
    const { enqueueResourceWebhookEvent } = await import(
      "../services/resources/webhooks.js"
    );
    await enqueueResourceWebhookEvent({
      type: "resource.grant.created",
      resource: {
        id: data.resourceId,
        applicationId: data.ids["owner-app"],
        uri: "file:///doc_1",
        scheme: "file",
        displayName: "Document",
        ownerType: "user",
        ownerId: "owner",
        status: "validated",
      },
      grant: {
        id: "00000000-0000-4000-8000-000000000001",
        subjectType: "plan",
        subjectId: data.planId,
        permission: "read",
      },
    });

    const sent = await deliveries(data);
    const toConsumer = sent.filter((d) => d.to === "consumer-app");
    expect(toConsumer).toHaveLength(1);
    expect(toConsumer[0]?.payload.grant).toMatchObject({
      subjectType: "user",
      subjectId: "inside",
    });
    expect(sent.filter((d) => d.to === "owner-app")).toHaveLength(3);
    expect(sent.some((d) => d.to === "other-app")).toBe(false);
  });

  it("still tells an application that its grant was revoked or changed", async () => {
    const data = await seed();
    const grant = await createResourceGrant({
      resourceId: data.resourceId,
      subjectType: "application",
      subjectId: "consumer-app",
      actorUserId: "owner",
    });
    await db.delete(resourceWebhookDeliveries);

    await updateResourceGrantPermission(grant.id, "write", "owner");
    await revokeResourceGrant(grant.id, "owner");
    const toConsumer = (await deliveries(data)).filter(
      (d) => d.to === "consumer-app",
    );
    expect(toConsumer.map((d) => d.type).sort()).toEqual([
      "resource.grant.revoked",
      "resource.grant.updated",
    ]);
    const updated = toConsumer.find((d) => d.type === "resource.grant.updated");
    expect(updated?.payload.grant).toMatchObject({
      permission: "write",
      previousPermission: "read",
    });
  });

  it("sends nothing to an application without a webhook", async () => {
    const data = await seed();
    await db
      .update(applications)
      .set({ resourceWebhookUrl: null, resourceWebhookSecret: null })
      .where(eq(applications.id, data.ids["consumer-app"]));
    await createResourceGrant({
      resourceId: data.resourceId,
      subjectType: "application",
      subjectId: "consumer-app",
      actorUserId: "owner",
    });
    expect((await deliveries(data)).map((d) => d.to)).toEqual(["owner-app"]);
  });
});
