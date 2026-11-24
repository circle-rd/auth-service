import { config } from "../config.js";
import { logger } from "../logger.js";
import { announceCatalogueChanged } from "./gateway-catalogue-events.js";
import { syncGatewayInventory } from "./gateway-inventory-mirror.js";
import { declareRelayResources } from "./resources/auto-declaration.js";

const SYNC_INTERVAL_MS = 5 * 60_000;

/** Sync, then announce the change when the active models moved. */
export async function syncAndAnnounce(): Promise<number> {
  const { count, changed } = await syncGatewayInventory();
  if (changed) await announceCatalogueChanged();
  return count;
}

/**
 * The scheduled and requested syncs also declare the relay models their owners
 * have not declared. Not part of `syncAndAnnounce`: validating a declaration
 * refreshes the inventory through it, which must not start another declaration.
 */
async function syncDeclareAndAnnounce(): Promise<number> {
  const count = await syncAndAnnounce();
  await declareRelayResources();
  return count;
}

let inventoryRun: Promise<void> | null = null;
let inventoryDirty = false;

async function drainInventorySync(): Promise<void> {
  while (inventoryDirty) {
    inventoryDirty = false;
    try {
      await syncDeclareAndAnnounce();
    } catch (err) {
      logger.warn({ err }, "[res] LiteLLM inventory sync failed");
    }
  }
}

/**
 * Run a sync now, coalescing bursts: a request that arrives while a sync runs
 * schedules exactly one more sync after it, never one per request.
 */
export function requestGatewayInventorySync(): void {
  inventoryDirty = true;
  if (inventoryRun) return;
  inventoryRun = drainInventorySync().finally(() => {
    inventoryRun = null;
  });
}

export function startGatewayInventorySync(): void {
  if (!config.litellm.url) {
    logger.info("[res] LiteLLM inventory disabled (LITELLM_URL is not set)");
    return;
  }
  const run = () => {
    void syncDeclareAndAnnounce()
      .then((count) => {
        if (count > 0) logger.info({ count }, "[res] LiteLLM inventory synced");
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "[res] LiteLLM inventory sync failed");
      });
  };
  run();
  const timer = setInterval(run, SYNC_INTERVAL_MS);
  timer.unref();
}
