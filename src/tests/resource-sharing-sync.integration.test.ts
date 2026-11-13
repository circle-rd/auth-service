import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  applications,
  sharedResources,
  subscriptionPlans,
} from "../db/schema.js";
import { LITELLM_GATEWAY_SLUG } from "../services/system-apps.js";
import { reconcileSharedResources } from "../services/resource-sharing/litellm-sync.js";
import { cleanDb } from "./helpers/db.js";

const GW = "https://gateway.example.test";
const GROUP = "owner-app:free";

let ownerId: string;
let updates: Array<{ path: string; body: Record<string, unknown> }>;

function setConfig(url: string | undefined): void {
  (config.litellm as { url?: string }).url = url;
  (config.features as { resourceSharing: boolean }).resourceSharing = true;
}

async function seed(): Promise<void> {
  await db.insert(applications).values({
    name: "Gateway",
    slug: LITELLM_GATEWAY_SLUG,
    url: GW,
    isSystem: true,
  });
  const [owner] = await db
    .insert(applications)
    .values({
      name: "Owner",
      slug: "owner-app",
      url: "https://owner.example.test",
      allowedResources: [GW],
    })
    .returning({ id: applications.id });
  ownerId = owner!.id;
  await db
    .insert(subscriptionPlans)
    .values({ applicationId: ownerId, name: "free", isDefault: true });
}

async function addResource(input: {
  type: "model" | "workflow" | "mcp_agent";
  slug: string;
  upstreamRef?: string;
  status?: "draft" | "published" | "disabled";
}): Promise<string> {
  const [row] = await db
    .insert(sharedResources)
    .values({
      ownerApplicationId: ownerId,
      resourceType: input.type,
      key: `owner-app/${input.slug}`,
      displayName: input.slug,
      upstreamRef: input.upstreamRef ?? null,
      status: input.status ?? "published",
    })
    .returning({ id: sharedResources.id });
  return row!.id;
}

function stubGateway(modelNames: string[], agentIds: string[] = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace(GW, "");
      if (path === "/v1/access_group" && (init.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify([
            {
              access_group_id: "group-1",
              access_group_name: GROUP,
              access_model_names: modelNames,
              access_mcp_server_ids: [],
              access_agent_ids: agentIds,
            },
          ]),
          { status: 200 },
        );
      }
      if (path === "/v1/access_group/group-1" && init.method === "PUT") {
        updates.push({
          path,
          body: JSON.parse(init.body as string) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            access_group_id: "group-1",
            access_group_name: GROUP,
            access_model_names: [],
            access_mcp_server_ids: [],
            access_agent_ids: [],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected gateway call: ${init.method} ${path}`);
    }),
  );
}

beforeEach(async () => {
  await cleanDb();
  updates = [];
  const dir = mkdtempSync(join(tmpdir(), "res-sync-it-"));
  const keyFile = join(dir, "resource-sync-key");
  writeFileSync(keyFile, "sk-resource-sync\n");
  (config.litellm as { resourceSyncKeyFile: string }).resourceSyncKeyFile =
    keyFile;
  setConfig(GW);
  await seed();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setConfig(undefined);
});

describe("shared-resource access-group sync", () => {
  it("merges published model and workflow membership into the owner plan group", async () => {
    await addResource({ type: "model", slug: "model-a" });
    await addResource({
      type: "workflow",
      slug: "wf-a",
      upstreamRef: "agent-id-1",
    });
    stubGateway(["operator/model"]);

    const report = await reconcileSharedResources();

    expect(report).toMatchObject({ updated: 1, failed: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      path: "/v1/access_group/group-1",
      body: {
        access_model_names: ["operator/model", "owner-app/model-a"],
        access_agent_ids: ["agent-id-1"],
      },
    });
  });

  it("removes a disabled resource without touching operator entries", async () => {
    const id = await addResource({ type: "model", slug: "model-a" });
    stubGateway(["operator/model", "owner-app/model-a"]);

    await db
      .update(sharedResources)
      .set({ status: "disabled" })
      .where(eq(sharedResources.id, id));

    await reconcileSharedResources();

    expect(updates).toEqual([
      {
        path: "/v1/access_group/group-1",
        body: { access_model_names: ["operator/model"] },
      },
    ]);
  });

  it("does nothing while the sharing flag is off", async () => {
    await addResource({ type: "model", slug: "model-a" });
    setConfig(undefined);
    const report = await reconcileSharedResources();
    expect(report.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
