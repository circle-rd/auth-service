import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { gatewayObjects } from "../db/gateway-schema.js";
import { linkResourceToGatewayObject } from "../services/gateway-inventory.js";
import { listHardwareForResources } from "../services/gateway-hardware.js";
import { requestGatewayInventorySync } from "../services/gateway-inventory-sync.js";
import { syncGatewayInventory } from "../services/gateway-inventory-mirror.js";
import { getEventBus, setEventBus, MemoryEventBus, type DomainEvent } from "../services/event-bus.js";
import { applications } from "../db/schema.js";
import { resources } from "../db/resource-schema.js";
import { resourceGatewayLinks } from "../db/gateway-schema.js";
import { syncBuiltinSchemes } from "../services/resources/scheme-service.js";
import { cleanDb } from "./helpers/db.js";

let originalUrl: string | undefined;
let originalKeyFile: string;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  await cleanDb();
  const dir = mkdtempSync(join(tmpdir(), "inventory-"));
  const keyFile = join(dir, "inventory-key");
  writeFileSync(keyFile, "sk-inventory\n");
  originalUrl = config.litellm.url;
  originalKeyFile = config.litellm.inventoryKeyFile;
  Object.assign(config.litellm, {
    url: "http://gateway.test",
    inventoryKeyFile: keyFile,
  });
});

afterEach(() => {
  Object.assign(config.litellm, {
    url: originalUrl,
    inventoryKeyFile: originalKeyFile,
  });
  vi.unstubAllGlobals();
});

describe("gateway inventory sync", () => {
  it("mirrors models, agents, MCP servers and tools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/models")) {
          return json({
            data: [{ id: "gpt-x" }, { id: "claude-x" }, { id: "smart-router" }],
          });
        }
        if (url.endsWith("/model/info")) {
          return json({
            data: [
              {
                model_name: "gpt-x",
                model_info: {
                  managed_by: "reverse-relay",
                  created_by: "bmz",
                  client_id: "bmz",
                  tags: ["text", "tools"],
                  supports_function_calling: true,
                },
              },
              {
                model_name: "claude-x",
                model_info: { created_by: "alice" },
              },
              {
                model_name: "smart-router",
                litellm_params: { model: "auto_router/complexity_router" },
                model_info: { created_by: "bmz" },
              },
            ],
          });
        }
        if (url.endsWith("/v1/agents")) {
          return json([{ agent_id: "a1", agent_name: "analyst" }]);
        }
        return json([
          {
            server_id: "s1",
            server_name: "server-x",
            allowed_tools: ["search", "read"],
            approval_status: "active",
          },
        ]);
      }),
    );

    await expect(syncGatewayInventory()).resolves.toMatchObject({
      count: 7,
      changed: true,
    });
    const rows = await db.select().from(gatewayObjects);
    expect(rows).toHaveLength(7);
    expect(
      rows.filter((row) => row.kind === "mcp_tool").map((row) => row.objectName).sort(),
    ).toEqual(["read", "search"]);
    const managed = rows.find((row) => row.objectName === "gpt-x");
    expect(managed?.metadata).toMatchObject({
      managedBy: "reverse-relay",
      createdBy: "bmz",
      clientId: "bmz",
      tags: ["text", "tools"],
      supports: { functionCalling: true },
    });
    const native = rows.find((row) => row.objectName === "claude-x");
    expect(native?.metadata).toMatchObject({ createdBy: "alice" });
    const router = rows.find((row) => row.objectName === "smart-router");
    expect(router?.metadata).toMatchObject({ createdBy: "bmz", router: true });
    expect(managed?.metadata).toMatchObject({ router: false });
    expect(rows.every((row) => row.isActive)).toBe(true);
  });

  it("marks objects missing from the latest inventory disabled", async () => {
    let models = [{ id: "gpt-x" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/models")) return json({ data: models });
        if (url.endsWith("/model/info")) return json({ data: [] });
        if (url.endsWith("/v1/agents")) return json([]);
        return json([]);
      }),
    );

    await syncGatewayInventory();
    models = [];
    await syncGatewayInventory();

    const [row] = await db
      .select()
      .from(gatewayObjects)
      .where(eq(gatewayObjects.objectName, "gpt-x"));
    expect(row?.isActive).toBe(false);
  });

  it("keeps the previous mirror when a fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/models")) return json({ data: [{ id: "gpt-x" }] });
        if (url.endsWith("/model/info")) return json({ data: [] });
        if (url.endsWith("/v1/agents")) return json([]);
        return json([]);
      }),
    );
    await syncGatewayInventory();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    await expect(syncGatewayInventory()).rejects.toThrow(/HTTP 500/);
    const rows = await db.select().from(gatewayObjects);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isActive).toBe(true);
  });

  it("reports a change only when the active models moved", async () => {
    let models = [{ id: "gpt-x" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/models")) return json({ data: models });
        if (url.endsWith("/model/info")) return json({ data: [] });
        if (url.endsWith("/v1/agents")) return json([]);
        return json([]);
      }),
    );

    await expect(syncGatewayInventory()).resolves.toMatchObject({ changed: true });
    await expect(syncGatewayInventory()).resolves.toMatchObject({ changed: false });
    models = [{ id: "gpt-x" }, { id: "gpt-y" }];
    await expect(syncGatewayInventory()).resolves.toMatchObject({ changed: true });
  });

  it("announces catalogue.changed to sharing applications only", async () => {
    await db.insert(applications).values([
      { name: "Chat", slug: "chat", resourceSharingEnabled: true },
      { name: "Private", slug: "private", resourceSharingEnabled: false },
    ]);
    const [sharing] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.slug, "chat"));
    const received: DomainEvent[] = [];
    const bus = new MemoryEventBus();
    const previous = getEventBus();
    setEventBus(bus);
    bus.subscribe((event) => received.push(event));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/models")) return json({ data: [{ id: "gpt-x" }] });
        if (url.endsWith("/model/info")) return json({ data: [] });
        if (url.endsWith("/v1/agents")) return json([]);
        return json([]);
      }),
    );

    try {
      requestGatewayInventorySync();
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toMatchObject({
        type: "catalogue.changed",
        rooms: [`app:${sharing!.id}`],
      });
    } finally {
      setEventBus(previous);
    }
  });

  describe("agent hardware", () => {
    const spark = {
      kind: "dgx-spark",
      product: " NVIDIA DGX Spark\u0007 ",
      vendor: "NVIDIA",
      gpus: ["NVIDIA GB10"],
      memoryMb: 122880,
      cpuArch: "aarch64",
      cpuCores: 20,
    };

    function stubGateway(modelInfo: Record<string, unknown>): void {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("/v1/models")) return json({ data: [{ id: "u-bmz/qwen" }] });
          if (url.endsWith("/model/info")) {
            return json({
              data: [{ model_name: "u-bmz/qwen", model_info: { managed_by: "reverse-relay", ...modelInfo } }],
            });
          }
          return json([]);
        }),
      );
    }

    async function seedLinkedResource(): Promise<string> {
      await syncBuiltinSchemes();
      const [app] = await db
        .insert(applications)
        .values({ name: "Catalogue", slug: "catalogue", resourceSharingEnabled: true })
        .returning({ id: applications.id });
      const [resource] = await db
        .insert(resources)
        .values({
          applicationId: app!.id,
          scheme: "llm",
          locator: "u-bmz/qwen",
          uri: "llm://u-bmz/qwen",
          displayName: "u-bmz/qwen",
          ownerType: "user",
          ownerId: "owner",
          status: "validated",
        })
        .returning({ id: resources.id, scheme: resources.scheme, locator: resources.locator });
      await linkResourceToGatewayObject(resource!);
      return resource!.id;
    }

    it("mirrors the distinct hardware of a model, cleaned of control characters", async () => {
      stubGateway({ hardware: [spark, spark, { ...spark, cpuCores: 8 }] });
      await syncGatewayInventory();
      const [row] = await db.select().from(gatewayObjects).where(eq(gatewayObjects.objectName, "u-bmz/qwen"));
      const hardware = (row?.metadata as { hardware: Array<{ product: string; cpuCores: number }> }).hardware;
      expect(hardware.map((entry) => entry.cpuCores)).toEqual([20, 8]);
      expect(hardware[0]?.product).toBe("NVIDIA DGX Spark");
    });

    it("drops a malformed hardware value and still mirrors the model", async () => {
      stubGateway({ hardware: [{ ...spark, gpus: new Array(9).fill("GPU") }] });
      await syncGatewayInventory();
      const [row] = await db.select().from(gatewayObjects).where(eq(gatewayObjects.objectName, "u-bmz/qwen"));
      expect(row?.isActive).toBe(true);
      expect(row?.metadata).not.toHaveProperty("hardware");
    });

    it("serves the hardware of a linked resource while its model is active", async () => {
      stubGateway({ hardware: [spark] });
      await syncGatewayInventory();
      const resourceId = await seedLinkedResource();
      const found = await listHardwareForResources([resourceId]);
      expect(found.get(resourceId)).toHaveLength(1);
      await db.update(gatewayObjects).set({ isActive: false });
      expect((await listHardwareForResources([resourceId])).size).toBe(0);
    });
  });

  describe("linking models by locator projection", () => {
    async function seedLinkableModel(name: string): Promise<void> {
      await db.insert(gatewayObjects).values({
        kind: "model",
        litellmId: name,
        objectName: name,
        displayName: name,
        metadata: { router: true },
      });
    }

    async function seedResource(locator: string): Promise<{ id: string; scheme: string; locator: string }> {
      await syncBuiltinSchemes();
      const [app] = await db
        .insert(applications)
        .values({ name: "Chat", slug: "chat", resourceSharingEnabled: true })
        .returning({ id: applications.id });
      const [resource] = await db
        .insert(resources)
        .values({
          applicationId: app!.id,
          scheme: "llm",
          locator,
          uri: `llm://${locator}`,
          displayName: locator,
          ownerType: "user",
          ownerId: "owner",
          status: "validated",
        })
        .returning({ id: resources.id, scheme: resources.scheme, locator: resources.locator });
      return resource!;
    }

    it("links the underscored locator to the model whose name has spaces", async () => {
      await seedLinkableModel("LITE Router");
      const resource = await seedResource("chat/LITE_Router");

      await expect(linkResourceToGatewayObject(resource)).resolves.toBe(true);

      const links = await db
        .select({ name: gatewayObjects.objectName })
        .from(resourceGatewayLinks)
        .innerJoin(gatewayObjects, eq(resourceGatewayLinks.gatewayObjectId, gatewayObjects.id))
        .where(eq(resourceGatewayLinks.resourceId, resource.id));
      expect(links).toEqual([{ name: "LITE Router" }]);
    });

    it("links the model already equal to a shared projection", async () => {
      await seedLinkableModel("FRONTIER Router");
      await seedLinkableModel("FRONTIER_Router");
      const resource = await seedResource("chat/FRONTIER_Router");

      await expect(linkResourceToGatewayObject(resource)).resolves.toBe(true);

      const links = await db
        .select({ name: gatewayObjects.objectName })
        .from(resourceGatewayLinks)
        .innerJoin(gatewayObjects, eq(resourceGatewayLinks.gatewayObjectId, gatewayObjects.id))
        .where(eq(resourceGatewayLinks.resourceId, resource.id));
      expect(links).toEqual([{ name: "FRONTIER_Router" }]);
    });

    it("links nothing when a shared projection has no model equal to it", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
      await seedLinkableModel("FRONTIER Router");
      await seedLinkableModel("FRONTIER\tRouter");
      const resource = await seedResource("chat/FRONTIER_Router");

      await expect(linkResourceToGatewayObject(resource)).resolves.toBe(false);
    });
  });
});
