import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { member, organization, user as userTable } from "../db/auth-schema.js";
import { gatewayObjects, resourceGatewayLinks } from "../db/gateway-schema.js";
import {
  resourceGrants,
  resourceInvitations,
  resourceUsageRecords,
  resourceWebhookDeliveries,
  resources,
} from "../db/resource-schema.js";
import { applications, userApplications } from "../db/schema.js";
import {
  createResourceGrant,
  deleteResourceGrant,
  revokeResourceGrant,
} from "../services/resources/grants.js";
import { getResource } from "../services/resources/registry.js";
import {
  deleteGrantsNamingSubject,
  deleteResourcesOwnedByUser,
  removeResource,
} from "../services/resources/resource-deletion.js";
import { sweepResourceGrantRetention } from "../services/resources/retention.js";
import {
  enableSchemeForApplication,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import { recordUsageEvent } from "../services/resources/usage.js";
import { encryptResourceWebhookSecret } from "../services/resources/webhooks.js";
import { cleanDb } from "./helpers/db.js";
import { makeSuperadminSession } from "./helpers/auth.js";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";

let handle: AuthServerHandle;
let ownerAppId: string;
let consumerAppId: string;
let documentId: string;

async function seedUser(id: string): Promise<void> {
  await db.insert(userTable).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    username: id,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedApp(slug: string) {
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
  return app;
}

async function seedDocument(locator: string, ownerId = "owner") {
  const [row] = await db
    .insert(resources)
    .values({
      applicationId: ownerAppId,
      scheme: "file",
      locator,
      uri: `file://${locator}`,
      displayName: locator,
      ownerType: "user",
      ownerId,
      status: "validated",
    })
    .returning();
  if (!row) throw new Error("resource seed failed");
  return row;
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
  Object.assign(config.resources, {
    enabledSchemes: [...new Set([...config.resources.enabledSchemes, "file"])],
  });
  await syncBuiltinSchemes();
  const owner = await seedApp("owner-app");
  const consumer = await seedApp("consumer-app");
  ownerAppId = owner.id;
  consumerAppId = consumer.id;
  await enableSchemeForApplication(ownerAppId, "file");
  await enableSchemeForApplication(consumerAppId, "file");
  for (const id of ["owner", "reader"]) {
    await seedUser(id);
    for (const appId of [ownerAppId, consumerAppId]) {
      await db
        .insert(userApplications)
        .values({ userId: id, applicationId: appId, isActive: true });
    }
  }
  documentId = (await seedDocument("/doc_1")).id;
});

describe("deleting a resource for good", () => {
  it("removes the row, its grants and invitations, and keeps usage without the resource id", async () => {
    await createResourceGrant({
      resourceId: documentId,
      subjectType: "application",
      subjectId: "consumer-app",
      actorUserId: "owner",
    });
    await createResourceGrant({
      resourceId: documentId,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "owner",
    });
    await db.insert(resourceInvitations).values({
      tokenHash: "hash",
      email: "someone@example.com",
      resourceId: documentId,
      expiresAt: new Date(Date.now() + 3600_000),
      createdBy: "owner",
    });
    await recordUsageEvent({
      subjectId: "reader",
      caller: { id: ownerAppId, slug: "owner-app" },
      resourceId: documentId,
      resourceUri: "file:///doc_1",
      requestId: "a".repeat(64),
      occurredAt: new Date(),
      usageSource: "unsupported",
      costUsd: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });

    await removeResource(documentId, "owner");

    await expect(getResource(documentId)).rejects.toMatchObject({ code: "RES_002" });
    expect(await db.select().from(resourceGrants)).toHaveLength(0);
    expect(await db.select().from(resourceInvitations)).toHaveLength(0);
    const [usage] = await db.select().from(resourceUsageRecords);
    expect(usage).toMatchObject({ resourceId: null, uri: "file:///doc_1" });
  });

  it("tells the owner application and the applications it was shared with", async () => {
    await createResourceGrant({
      resourceId: documentId,
      subjectType: "application",
      subjectId: "consumer-app",
      actorUserId: "owner",
    });
    await db.delete(resourceWebhookDeliveries);
    await removeResource(documentId, "owner");

    const sent = await db.select().from(resourceWebhookDeliveries);
    expect(sent.map((row) => row.eventType)).toEqual([
      "resource.deleted",
      "resource.deleted",
    ]);
    const byApp = new Map(
      sent.map((row) => [row.applicationId, row.payload as { resource: Record<string, unknown> }]),
    );
    expect(byApp.get(ownerAppId)?.resource).toHaveProperty("ownerId", "owner");
    expect(byApp.get(consumerAppId)?.resource).not.toHaveProperty("ownerId");
    expect(byApp.get(consumerAppId)?.resource).toMatchObject({ uri: "file:///doc_1" });
  });

  it("is refused for anyone who cannot manage the resource", async () => {
    await expect(removeResource(documentId, "reader")).rejects.toMatchObject({
      code: "RES_002",
    });
    await expect(getResource(documentId)).resolves.toMatchObject({ id: documentId });
  });

  it("waits until the relay stops serving a model, then goes", async () => {
    const [object] = await db
      .insert(gatewayObjects)
      .values({
        kind: "model",
        litellmId: "u-owner/qwen",
        objectName: "u-owner/qwen",
        displayName: "u-owner/qwen",
        metadata: { managedBy: "reverse-relay", clientId: "u-owner" },
      })
      .returning();
    await db
      .insert(resourceGatewayLinks)
      .values({ resourceId: documentId, gatewayObjectId: object!.id });

    await expect(removeResource(documentId, "owner")).rejects.toMatchObject({
      code: "RES_019",
    });
    await db.update(gatewayObjects).set({ isActive: false });
    await expect(removeResource(documentId, "owner")).resolves.toMatchObject({
      id: documentId,
    });
  });
});

describe("deleting a grant for good", () => {
  it("refuses an active grant and deletes a revoked or expired one", async () => {
    const grant = await createResourceGrant({
      resourceId: documentId,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "owner",
    });
    await expect(deleteResourceGrant(grant.id, "owner")).rejects.toMatchObject({
      code: "RES_020",
    });
    await expect(deleteResourceGrant(grant.id, "reader")).rejects.toMatchObject({
      code: "RES_002",
    });

    await revokeResourceGrant(grant.id, "owner");
    await deleteResourceGrant(grant.id, "owner");
    expect(await db.select().from(resourceGrants)).toHaveLength(0);

    const expired = await createResourceGrant({
      resourceId: documentId,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "owner",
    });
    await db
      .update(resourceGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(resourceGrants.id, expired.id));
    await deleteResourceGrant(expired.id, "owner");
    expect(await db.select().from(resourceGrants)).toHaveLength(0);
  });
});

describe("retention of grants and invitations", () => {
  it("deletes old inactive ones and never an active grant or a pending invitation", async () => {
    const old = new Date(Date.now() - (config.resources.grantRetentionDays + 5) * 86_400_000);
    const recent = new Date(Date.now() - 86_400_000);
    const base = { resourceId: documentId, subjectType: "user" as const, createdBy: "owner" };
    await db.insert(resourceGrants).values([
      { ...base, subjectId: "old-revoked", revokedAt: old },
      { ...base, subjectId: "old-expired", expiresAt: old },
      { ...base, subjectId: "recent-revoked", revokedAt: recent },
      { ...base, subjectId: "old-active-no-expiry" },
      { ...base, subjectId: "future", expiresAt: new Date(Date.now() + 86_400_000) },
    ]);
    const invitation = (email: string, fields: Partial<typeof resourceInvitations.$inferInsert>) => ({
      tokenHash: email,
      email,
      resourceId: documentId,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdBy: "owner",
      ...fields,
    });
    await db.insert(resourceInvitations).values([
      invitation("old-consumed", { consumedAt: old }),
      invitation("old-revoked", { revokedAt: old }),
      invitation("old-expired", { expiresAt: old }),
      invitation("pending", {}),
      invitation("recent-consumed", { consumedAt: recent }),
    ]);

    expect(await sweepResourceGrantRetention()).toEqual({ grants: 2, invitations: 3 });

    const kept = (await db.select().from(resourceGrants)).map((g) => g.subjectId).sort();
    expect(kept).toEqual(["future", "old-active-no-expiry", "recent-revoked"]);
    const pending = (await db.select().from(resourceInvitations)).map((i) => i.email).sort();
    expect(pending).toEqual(["pending", "recent-consumed"]);
  });
});

describe("grants and resources that name a deleted subject", () => {
  it("deletes the grants naming an application when it is deleted over HTTP", async () => {
    await createResourceGrant({
      resourceId: documentId,
      subjectType: "application",
      subjectId: "consumer-app",
      actorUserId: "owner",
    });
    await createResourceGrant({
      resourceId: documentId,
      subjectType: "user",
      subjectId: "reader",
      actorUserId: "owner",
    });
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      makeSuperadminSession() as unknown as Awaited<ReturnType<typeof auth.api.getSession>>,
    );
    const res = await handle.app.inject({
      method: "DELETE",
      url: `/api/admin/applications/${consumerAppId}`,
    });
    expect(res.statusCode).toBe(204);
    const left = await db.select().from(resourceGrants);
    expect(left.map((g) => g.subjectType)).toEqual(["user"]);
  });

  it("deletes a user's resources and the grants naming them", async () => {
    await seedUser("leaving");
    await db
      .insert(userApplications)
      .values({ userId: "leaving", applicationId: ownerAppId, isActive: true });
    const theirs = await seedDocument("/theirs", "leaving");
    await createResourceGrant({
      resourceId: documentId,
      subjectType: "user",
      subjectId: "leaving",
      actorUserId: "owner",
    });
    await db.transaction(async (tx) => {
      await deleteResourcesOwnedByUser("leaving", tx);
      await deleteGrantsNamingSubject("user", "leaving", tx);
    });
    await expect(getResource(theirs.id)).rejects.toMatchObject({ code: "RES_002" });
    expect(await db.select().from(resourceGrants)).toHaveLength(0);
    await expect(getResource(documentId)).resolves.toMatchObject({ id: documentId });
  });

  it("deletes the grants naming an organization", async () => {
    await db.insert(organization).values({
      id: "org-1",
      name: "Team",
      slug: "team",
      createdAt: new Date(),
    });
    await db.insert(member).values({
      id: "m1",
      organizationId: "org-1",
      userId: "owner",
      role: "member",
      createdAt: new Date(),
    });
    await createResourceGrant({
      resourceId: documentId,
      subjectType: "organization",
      subjectId: "org-1",
      actorUserId: "owner",
    });
    expect(await deleteGrantsNamingSubject("organization", "org-1")).toBe(1);
    expect(await db.select().from(resourceGrants)).toHaveLength(0);
  });
});
