import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { gatewayObjects } from "../db/gateway-schema.js";
import { applications } from "../db/schema.js";
import { listModelCandidates } from "../services/resources/model-candidates.js";
import { cleanDb } from "./helpers/db.js";

async function seedUser(
  id: string,
  username: string,
  role = "user",
): Promise<void> {
  await db.insert(user).values({
    id,
    name: id,
    email: `${username}@example.com`,
    emailVerified: true,
    username,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedModel(
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

let appId: string;

beforeEach(async () => {
  await cleanDb();
  await seedUser("owner", "bmz");
  await seedUser("alice", "alice");
  await seedUser("admin", "root", "admin");
  const [app] = await db
    .insert(applications)
    .values({ name: "Chat", slug: "chat", resourceSharingEnabled: true })
    .returning({ id: applications.id });
  appId = app!.id;
  await seedModel("u-bmz/qwen", {
    managedBy: "reverse-relay",
    createdBy: "u-bmz",
    clientId: "u-bmz",
    tags: ["text", "tools"],
    supports: { functionCalling: true },
  });
  await seedModel("owned-native", { createdBy: "bmz" });
  await seedModel("alice-model", { createdBy: "alice" });
  await seedModel("unowned-native", {});
  await seedModel("bmz/router", {
    createdBy: "bmz",
    router: true,
  });
});

describe("model candidates", () => {
  it("shows administrators every model of the requested source", async () => {
    const managed = await listModelCandidates({
      appId,
      userId: "admin",
      source: "managed",
    });
    expect(managed.map((model) => model.name)).toEqual(["u-bmz/qwen"]);
    expect(managed[0]).toMatchObject({
      // A relay model carries its owner's namespace and is its own locator.
      locator: "u-bmz/qwen",
      owned: false,
      createdBy: "u-bmz",
      clientId: "u-bmz",
      tags: ["text", "tools"],
      supports: { functionCalling: true },
    });

    const native = await listModelCandidates({
      appId,
      userId: "admin",
      source: "native",
    });
    expect(native.map((model) => model.name)).toEqual([
      "alice-model",
      "bmz/router",
      "owned-native",
      "unowned-native",
    ]);
    expect(native.find((model) => model.name === "bmz/router")?.kind).toBe(
      "router",
    );
  });

  it("shows a member only the managed models they own", async () => {
    const models = await listModelCandidates({
      appId,
      userId: "owner",
      source: "managed",
    });
    expect(models.map((model) => model.name)).toEqual(["u-bmz/qwen"]);
    expect(models[0]?.owned).toBe(true);
  });

  it("shows a member only the native models with a matching owner", async () => {
    const models = await listModelCandidates({
      appId,
      userId: "owner",
      source: "native",
    });
    expect(models.map((model) => model.name)).toEqual([
      "bmz/router",
      "owned-native",
    ]);
    expect(models.map((model) => model.kind)).toEqual(["router", "model"]);
  });

  it("hides unowned native models and other accounts from members", async () => {
    const models = await listModelCandidates({
      appId,
      userId: "alice",
      source: "native",
    });
    expect(models.map((model) => model.name)).toEqual(["alice-model"]);
  });
});

describe("locator projection of model names", () => {
  it("offers a model whose name has spaces under its underscored locator", async () => {
    await seedModel("LITE Router", { router: true });
    const native = await listModelCandidates({
      appId,
      userId: "admin",
      source: "native",
    });
    expect(native.find((model) => model.name === "LITE Router")).toMatchObject({
      locator: "chat/LITE_Router",
      kind: "router",
    });
  });

  it("offers only the model already equal to a shared projection", async () => {
    await seedModel("FRONTIER Router", { router: true });
    await seedModel("FRONTIER_Router", { router: true });
    const native = await listModelCandidates({
      appId,
      userId: "admin",
      source: "native",
    });
    const names = native.map((model) => model.name);
    expect(names).not.toContain("FRONTIER Router");
    expect(names).toContain("FRONTIER_Router");
  });
});
