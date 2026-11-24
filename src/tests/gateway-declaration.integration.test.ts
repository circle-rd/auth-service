import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { gatewayObjects } from "../db/gateway-schema.js";
import { applications, userApplications } from "../db/schema.js";
import { validateRelayDeclaration } from "../services/resources/gateway-declaration.js";
import { createResource } from "../services/resources/registry.js";
import {
  enableSchemeForApplication,
  syncBuiltinSchemes,
} from "../services/resources/scheme-service.js";
import { cleanDb } from "./helpers/db.js";

let appId: string;

async function seedUser(id: string, username: string): Promise<void> {
  await db.insert(user).values({
    id,
    name: username,
    email: `${username}@example.com`,
    emailVerified: true,
    username,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(userApplications).values({
    userId: id,
    applicationId: appId,
    isActive: true,
  });
}

async function seedObject(
  objectName: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.insert(gatewayObjects).values({
    kind: "model",
    litellmId: objectName,
    objectName,
    displayName: objectName,
    metadata,
  });
}

beforeEach(async () => {
  await cleanDb();
  const [app] = await db
    .insert(applications)
    .values({ name: "App A", slug: "app-a", resourceSharingEnabled: true })
    .returning({ id: applications.id });
  appId = app!.id;
  await syncBuiltinSchemes();
  await enableSchemeForApplication(appId, "llm");
  await seedUser("bmz-id", "bmz");
  await seedUser("alice-id", "alice");
  await seedObject("bmz/qwen3.8", {
    managedBy: "reverse-relay",
    clientId: "bmz",
    reverseName: "bmz/qwen3.8",
    tags: ["text", "tools"],
  });
  await seedObject("native/gpt", { createdBy: "bmz" });
});

async function declare(ownerId: string, locator: string) {
  return createResource({
    applicationId: appId,
    scheme: "llm",
    locator,
    displayName: "Model",
    ownerType: "user",
    ownerId,
  });
}

describe("relay declarations", () => {
  it("validates a model the relay learned for the declaring account", async () => {
    const created = await declare("bmz-id", "app-a/bmz/qwen3.8");
    const validated = await validateRelayDeclaration(created, "bmz");
    expect(validated.status).toBe("validated");
  });

  it("keeps another account's relay model pending for a platform decision", async () => {
    const created = await declare("alice-id", "app-a/bmz/qwen3.8");
    const pending = await validateRelayDeclaration(created, "alice");
    expect(pending.status).toBe("pending_validation");
  });

  it("keeps a native LiteLLM model pending, even one whose created_by names the declarer", async () => {
    const created = await declare("bmz-id", "app-a/native/gpt");
    const pending = await validateRelayDeclaration(created, "bmz");
    expect(pending.status).toBe("pending_validation");
  });

  it("never auto-validates when the account has no username", async () => {
    const created = await declare("bmz-id", "app-a/bmz/qwen3.8");
    const pending = await validateRelayDeclaration(created, null);
    expect(pending.status).toBe("pending_validation");
  });
});
