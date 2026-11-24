import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "../auth.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { applications, userApplications } from "../db/schema.js";
import { createAppSchema } from "../routes/admin/application-create.js";
import { createResource, removeResource } from "../services/resources/registry.js";
import {
  enableSchemeForApplication,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import { assertUsernameChangeAllowed } from "../services/usernames.js";
import { cleanDb } from "./helpers/db.js";
import { makeUserSession } from "./helpers/auth.js";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";

let handle: AuthServerHandle;
let appId: string;

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
  await db
    .insert(userApplications)
    .values({ userId: id, applicationId: appId, isActive: true });
}

function declare(ownerId: string, locator: string) {
  return createResource({
    applicationId: appId,
    scheme: "llm",
    locator,
    displayName: "Model",
    ownerType: "user",
    ownerId,
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
    .values({ name: "Chat", slug: "chat", resourceSharingEnabled: true })
    .returning();
  if (!app) throw new Error("application seed failed");
  appId = app.id;
  await enableSchemeForApplication(appId, "llm");
});

describe("application slugs and the user namespace", () => {
  it("refuses a slug in the user namespace in the database and in the create schema", async () => {
    await expect(
      db.insert(applications).values({ name: "Sneaky", slug: "u-alice" }),
    ).rejects.toThrow();
    const base = { name: "App", description: "x" };
    expect(createAppSchema.safeParse({ ...base, slug: "u-alice" }).success).toBe(false);
    expect(createAppSchema.safeParse({ ...base, slug: "ux-alice" }).success).toBe(true);
    expect(createAppSchema.safeParse({ ...base, slug: "gine" }).success).toBe(true);
  });
});

describe("renaming a username that owns resources", () => {
  it("is allowed until the account declares a resource in its namespace", async () => {
    await seedUser("alice", "alice");
    await expect(assertUsernameChangeAllowed("alice", "alicia")).resolves.toBeUndefined();
    await expect(assertUsernameChangeAllowed("alice", undefined)).resolves.toBeUndefined();

    const resource = await declare("alice", "u-alice/qwen");
    await expect(assertUsernameChangeAllowed("alice", "alicia")).rejects.toMatchObject({
      code: "RES_018",
    });
    await expect(assertUsernameChangeAllowed("alice", null)).rejects.toMatchObject({
      code: "RES_018",
    });
    // Same name in another case is not a change.
    await expect(assertUsernameChangeAllowed("alice", "ALICE")).resolves.toBeUndefined();

    await removeResource(resource.id, "alice");
    await expect(assertUsernameChangeAllowed("alice", "alicia")).resolves.toBeUndefined();
  });

  it("matches the namespace exactly, underscores included", async () => {
    await seedUser("a-b", "a_b");
    await seedUser("axb", "axb");
    await declare("axb", "u-axb/m");
    // `_` is a LIKE wildcard: a_b must not be blocked by axb's resource.
    await expect(assertUsernameChangeAllowed("a-b", "other")).resolves.toBeUndefined();
  });

  it("is refused with 409 on the self-service profile route", async () => {
    await seedUser("alice", "alice");
    await declare("alice", "u-alice/qwen");
    vi.spyOn(auth.api, "getSession").mockResolvedValue(
      makeUserSession("alice") as unknown as Awaited<ReturnType<typeof auth.api.getSession>>,
    );
    const res = await handle.app.inject({
      method: "PATCH",
      url: "/api/user/profile",
      payload: { username: "alicia" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("RES_018");
    const [row] = await db.select().from(userTable).where(eq(userTable.id, "alice"));
    expect(row?.username).toBe("alice");
  });
});

describe("declaring in a namespace", () => {
  it("needs a username and the owner's own namespace", async () => {
    await seedUser("nameless", null);
    await seedUser("bob", "Bob_1".toLowerCase());
    await expect(declare("nameless", "u-nameless/m")).rejects.toMatchObject({
      code: "RES_017",
    });
    await expect(declare("bob", "u-bob_1/m")).resolves.toMatchObject({
      uri: "llm://u-bob_1/m",
    });
    await expect(declare("bob", "chat/m")).rejects.toMatchObject({ code: "RES_005" });
  });
});
