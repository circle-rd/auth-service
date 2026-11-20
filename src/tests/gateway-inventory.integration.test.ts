import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { gatewayObjects } from "../db/gateway-schema.js";
import { syncGatewayInventory } from "../services/gateway-inventory.js";
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
          return json({ data: [{ id: "gpt-x" }, { id: "claude-x" }] });
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

    await expect(syncGatewayInventory()).resolves.toBe(6);
    const rows = await db.select().from(gatewayObjects);
    expect(rows).toHaveLength(6);
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
});
