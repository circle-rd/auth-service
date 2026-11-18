import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { auth } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { applications, appDelegations, userApplications } from "../db/schema.js";
import { resources } from "../db/resource-schema.js";
import { user as userTable } from "../db/auth-schema.js";
import {
  enableSchemeForApplication,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import { cleanDb } from "./helpers/db.js";
import { makeUserSession } from "./helpers/auth.js";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";

let handle: AuthServerHandle;
let appId: string;
let resourceId: string;
let sharedResourceId: string;

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
      name: "Grant app",
      slug: "grant-app",
      isActive: true,
      resourceSharingEnabled: true,
    })
    .returning();
  if (!app) throw new Error("application seed failed");
  appId = app.id;
  await enableSchemeForApplication(appId, "llm");
  await seedUser("owner");
  await seedUser("grant-manager");
  await seedUser("resource-manager");
  await db.insert(userApplications).values([
    { userId: "owner", applicationId: appId, isActive: true },
    { userId: "grant-manager", applicationId: appId, isActive: true },
  ]);
  await db.insert(appDelegations).values([
    {
      userId: "grant-manager",
      applicationId: appId,
      permission: "grants:manage",
      status: "active",
    },
    {
      userId: "resource-manager",
      applicationId: appId,
      permission: "resources:manage",
      status: "active",
    },
  ]);
  const [resource] = await db
    .insert(resources)
    .values({
      applicationId: appId,
      scheme: "llm",
      locator: "demo/model",
      uri: "llm://grant-app/demo/model",
      displayName: "Demo model",
      ownerType: "user",
      ownerId: "owner",
      status: "validated",
    })
    .returning();
  if (!resource) throw new Error("resource seed failed");
  resourceId = resource.id;
  const [shared] = await db
    .insert(resources)
    .values({
      applicationId: appId,
      scheme: "llm",
      locator: "grant-app/shared",
      uri: "llm://grant-app/shared",
      displayName: "Shared model",
      ownerType: "application",
      ownerId: appId,
      status: "validated",
    })
    .returning();
  if (!shared) throw new Error("resource seed failed");
  sharedResourceId = shared.id;
});

function asUser(id: string): void {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(
    makeUserSession(id) as unknown as Awaited<
      ReturnType<typeof auth.api.getSession>
    >,
  );
}

async function getGrants(id: string = resourceId): Promise<number> {
  const res = await handle.app.inject({
    method: "GET",
    url: `/api/user/resources/${id}/grants`,
  });
  return res.statusCode;
}

describe("resource grant administration over HTTP", () => {
  it("leaves a personal resource's grants to its owner alone", async () => {
    asUser("owner");
    expect(await getGrants()).toBe(200);

    asUser("grant-manager");
    expect(await getGrants()).toBe(404);

    asUser("resource-manager");
    expect(await getGrants()).toBe(404);
  });

  it("allows a grants:manage delegate on an application-owned resource, and denies resources:manage only", async () => {
    asUser("grant-manager");
    expect(await getGrants(sharedResourceId)).toBe(200);

    asUser("owner");
    expect(await getGrants(sharedResourceId)).toBe(404);

    asUser("resource-manager");
    // Grant administration is concealed from resource managers as a 404.
    expect(await getGrants(sharedResourceId)).toBe(404);
  });

  it("returns the deployment's enabled schemes with the catalogue", async () => {
    asUser("owner");
    const res = await handle.app.inject({
      method: "GET",
      url: "/api/user/resource-catalogue",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabledSchemes).toEqual(config.resources.enabledSchemes);
  });
});
