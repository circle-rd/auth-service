import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { walletPricingSettings } from "../db/schema.js";
import { config } from "../config.js";
import {
  getPricingSettings,
  getUsdPricing,
  listPricingHistory,
  updatePricingSettings,
} from "../services/wallet/index.js";
import { cleanDb } from "./helpers/db.js";

async function seedActor(id = "actor-1", name = "Ada") {
  await db.insert(user).values({
    id,
    name,
    email: `${id}@example.com`,
    emailVerified: true,
    role: "superadmin",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("wallet pricing settings", () => {
  beforeEach(async () => {
    await cleanDb();
    await db.delete(walletPricingSettings);
  });

  it("falls back to the environment until a change is saved", async () => {
    expect(await getPricingSettings()).toEqual({
      usdToEurRate: config.wallet.usdToEurRate,
      marginPercent: config.wallet.marginPercent,
      source: "environment",
      change: null,
    });
  });

  it("uses the newest saved change, with its author", async () => {
    await seedActor();
    await updatePricingSettings({
      usdToEurRate: "0.91",
      marginPercent: 5,
      actorId: "actor-1",
      reason: "first",
    });
    const latest = await updatePricingSettings({
      usdToEurRate: "0.93",
      marginPercent: 12,
      actorId: "actor-1",
      reason: "second",
    });

    expect(latest.actor).toEqual({ id: "actor-1", name: "Ada" });
    expect(await getUsdPricing()).toEqual({
      usdToEurRate: "0.93",
      marginPercent: 12,
    });
    const settings = await getPricingSettings();
    expect(settings).toMatchObject({ source: "database" });
    expect(settings?.change?.reason).toBe("second");
  });

  it("keeps every change, newest first, even from a deleted author", async () => {
    await seedActor();
    await updatePricingSettings({
      usdToEurRate: "0.91",
      marginPercent: 0,
      actorId: "actor-1",
      reason: "first",
    });
    await updatePricingSettings({
      usdToEurRate: "0.92",
      marginPercent: 0,
      actorId: "ghost",
      reason: "second",
    });
    const history = await listPricingHistory();
    expect(history.map((h) => h.reason)).toEqual(["second", "first"]);
    expect(history[0]?.actor).toEqual({ id: "ghost", name: null });
  });

  it.each([
    ["a zero rate", "0", 0],
    ["a malformed rate", "abc", 0],
    ["a negative margin", "0.9", -1],
    ["a margin above 1000", "0.9", 1001],
  ])("rejects %s at the database level", async (_label, rate, margin) => {
    await expect(
      db.insert(walletPricingSettings).values({
        usdToEurRate: rate,
        marginPercent: margin,
        actorUserId: "a",
        reason: "r",
      }),
    ).rejects.toThrow();
  });
});
