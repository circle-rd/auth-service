import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { gatewayObjects } from "../db/gateway-schema.js";
import { resources } from "../db/resource-schema.js";
import { applications, userApplications } from "../db/schema.js";
import { declareRelayResources } from "../services/resources/auto-declaration.js";
import {
  CATALOGUE_SLUG,
  ensureCatalogueApplication,
} from "../services/resources/catalogue-app.js";
import { syncBuiltinSchemes } from "../services/resources/scheme-service.js";
import { cleanDb } from "./helpers/db.js";

async function seedUser(id: string, username: string | null): Promise<void> {
  await db.insert(userTable).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    username,
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedObject(
  name: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.insert(gatewayObjects).values({
    kind: "model",
    litellmId: name,
    objectName: name,
    displayName: name,
    metadata,
  });
}

const relay = (clientId: string, name: string) => ({
  managedBy: "reverse-relay",
  clientId,
  reverseName: name,
});

beforeEach(async () => {
  await cleanDb();
  await syncBuiltinSchemes();
  await ensureCatalogueApplication();
  await seedUser("alice-id", "alice");
  await seedUser("nameless-id", null);
  await seedObject("u-alice/qwen", relay("u-alice", "u-alice/qwen"));
  await seedObject("u-ghost/x", relay("u-ghost", "u-ghost/x"));
  await seedObject("u-alice/native", { createdBy: "u-alice" });
  await seedObject("u-alice/forged", relay("u-bob", "u-alice/forged"));
  await seedObject("bmz/legacy", relay("bmz", "bmz/legacy"));
});

describe("catalogue application", () => {
  it("is a hidden system application with sharing on and no OAuth client", async () => {
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.slug, CATALOGUE_SLUG));
    expect(app).toMatchObject({ isSystem: true, resourceSharingEnabled: true });
    await ensureCatalogueApplication();
    const all = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.slug, CATALOGUE_SLUG));
    expect(all).toHaveLength(1);
  });

  it("refuses to take over an ordinary application of that name", async () => {
    await db.delete(applications).where(eq(applications.slug, CATALOGUE_SLUG));
    await db
      .insert(applications)
      .values({ name: "Mine", slug: CATALOGUE_SLUG, isSystem: false });
    await expect(ensureCatalogueApplication()).rejects.toThrow(/not a system one/);
  });
});

describe("relay model auto-declaration", () => {
  it("declares and validates only a model the relay published for an existing username", async () => {
    expect(await declareRelayResources()).toBe(1);
    const rows = await db.select().from(resources);
    expect(rows.map((r) => r.uri)).toEqual(["llm://u-alice/qwen"]);
    expect(rows[0]).toMatchObject({
      ownerType: "user",
      ownerId: "alice-id",
      status: "validated",
    });
    const [catalogue] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.slug, CATALOGUE_SLUG));
    expect(rows[0]?.applicationId).toBe(catalogue?.id);
    const [membership] = await db
      .select()
      .from(userApplications)
      .where(
        and(
          eq(userApplications.userId, "alice-id"),
          eq(userApplications.applicationId, catalogue!.id),
        ),
      );
    expect(membership?.isActive).toBe(true);
  });

  it("is idempotent", async () => {
    await declareRelayResources();
    expect(await declareRelayResources()).toBe(0);
    expect(await db.select().from(resources)).toHaveLength(1);
  });

  it("does nothing for an owner without a username", async () => {
    await db.update(userTable).set({ username: null }).where(eq(userTable.id, "alice-id"));
    expect(await declareRelayResources()).toBe(0);
    expect(await db.select().from(resources)).toHaveLength(0);
  });

  it("skips an inactive object", async () => {
    await db.update(gatewayObjects).set({ isActive: false });
    expect(await declareRelayResources()).toBe(0);
  });
});
