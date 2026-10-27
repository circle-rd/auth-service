import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import {
  applications,
  billingUsageEvents,
  billingUsagePeriods,
  subscriptionPlanPrices,
  subscriptionPlans,
  userSubscriptions,
} from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";

const { stripeHolder, calls } = vi.hoisted(() => {
  const calls = {
    meterEvents: [] as {
      event_name: string;
      payload: Record<string, string>;
      identifier: string;
    }[],
    customers: [] as unknown[],
  };
  const stripe = {
    customers: {
      create: vi.fn(async (p: unknown) => {
        calls.customers.push(p);
        return { id: `cus_${calls.customers.length}` };
      }),
    },
    billing: {
      meterEvents: {
        create: vi.fn(
          async (p: {
            event_name: string;
            payload: Record<string, string>;
            identifier: string;
          }) => {
            calls.meterEvents.push(p);
            return { identifier: p.identifier };
          },
        ),
      },
    },
  };
  return { stripeHolder: { stripe }, calls };
});

vi.mock("../services/stripe.js", () => ({
  get stripe() {
    return stripeHolder.stripe;
  },
}));

import {
  billingPeriodStart,
  pushPendingMeterEvents,
  recordMeteredUsage,
} from "../services/billing/usage.js";

beforeEach(async () => {
  await cleanDb();
  calls.meterEvents.length = 0;
  calls.customers.length = 0;
  stripeHolder.stripe.billing.meterEvents.create.mockReset();
  stripeHolder.stripe.billing.meterEvents.create.mockImplementation(
    async (p) => {
      calls.meterEvents.push(p);
      return { identifier: p.identifier };
    },
  );
});

async function seed(usageLimit = 100) {
  await db.insert(user).values({
    id: "u1",
    name: "u1",
    email: "u1@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const [app] = await db
    .insert(applications)
    .values({ name: "App", slug: "app", isActive: true })
    .returning();
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: app!.id, name: "pro", isDefault: true })
    .returning();
  await db.insert(subscriptionPlanPrices).values({
    planId: plan!.id,
    name: "API calls",
    amount: "10",
    interval: "month",
    billingType: "metered",
    featureKey: "api.calls",
    unit: "call",
    usageLimit,
    stripePriceId: "price_m",
    stripeMeterId: "meter_m",
  });
  await db.insert(userSubscriptions).values({
    userId: "u1",
    applicationId: app!.id,
    planId: plan!.id,
    isActive: true,
  });
  return { app: app!, plan: plan! };
}

async function periodTotal(appId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ quantity: billingUsagePeriods.quantity })
    .from(billingUsagePeriods)
    .where(eq(billingUsagePeriods.applicationId, appId));
  return row?.quantity;
}

describe("recordMeteredUsage", () => {
  it("records usage, aggregates by period and pushes a meter event", async () => {
    const { app } = await seed();
    expect(
      await recordMeteredUsage({
        userId: "u1",
        applicationId: app.id,
        key: "api.calls",
        value: 30,
      }),
    ).toEqual({ key: "api.calls", total: "30" });

    expect(await periodTotal(app.id)).toBe("30");
    expect(calls.meterEvents).toHaveLength(1);
    expect(calls.meterEvents[0]).toMatchObject({
      event_name: "app_app__api.calls",
      payload: { stripe_customer_id: "cus_1", value: "30" },
    });

    const [event] = await db
      .select({
        identifier: billingUsageEvents.stripeMeterEventIdentifier,
        period: billingUsageEvents.billingPeriodStart,
      })
      .from(billingUsageEvents);
    expect(event?.identifier).toBe(calls.meterEvents[0]!.identifier);
    expect(event?.period).toEqual(billingPeriodStart());
  });

  it("does not double count a repeated idempotency key", async () => {
    const { app } = await seed();
    await recordMeteredUsage({
      userId: "u1",
      applicationId: app.id,
      key: "api.calls",
      value: 30,
      idempotencyKey: "k1",
    });
    const second = await recordMeteredUsage({
      userId: "u1",
      applicationId: app.id,
      key: "api.calls",
      value: 30,
      idempotencyKey: "k1",
    });
    expect(second?.total).toBe("30");
    expect(await periodTotal(app.id)).toBe("30");
    expect(calls.meterEvents).toHaveLength(1);
    expect(await db.select().from(billingUsageEvents)).toHaveLength(1);
  });

  it("refuses usage past the hard cap and records nothing", async () => {
    const { app } = await seed(100);
    await recordMeteredUsage({
      userId: "u1",
      applicationId: app.id,
      key: "api.calls",
      value: 50,
    });
    await expect(
      recordMeteredUsage({
        userId: "u1",
        applicationId: app.id,
        key: "api.calls",
        value: 60,
      }),
    ).rejects.toMatchObject({ code: "BIL_003" });
    expect(await periodTotal(app.id)).toBe("50");
    expect(calls.meterEvents).toHaveLength(1);
    expect(await db.select().from(billingUsageEvents)).toHaveLength(1);
  });

  it("treats -1 as unlimited", async () => {
    const { app } = await seed(-1);
    await recordMeteredUsage({
      userId: "u1",
      applicationId: app.id,
      key: "api.calls",
      value: 10_000,
    });
    expect(await periodTotal(app.id)).toBe("10000");
  });

  it("returns null for a key that is not a metered feature", async () => {
    const { app } = await seed();
    expect(
      await recordMeteredUsage({
        userId: "u1",
        applicationId: app.id,
        key: "not-metered",
        value: 1,
      }),
    ).toBeNull();
    expect(calls.meterEvents).toHaveLength(0);
  });

  it("keeps a failed push pending and the retry job sends it", async () => {
    const { app } = await seed();
    stripeHolder.stripe.billing.meterEvents.create.mockRejectedValueOnce(
      new Error("stripe down"),
    );
    await recordMeteredUsage({
      userId: "u1",
      applicationId: app.id,
      key: "api.calls",
      value: 5,
    });
    const [pending] = await db
      .select({ identifier: billingUsageEvents.stripeMeterEventIdentifier })
      .from(billingUsageEvents);
    expect(pending?.identifier).toBeNull();

    expect(await pushPendingMeterEvents()).toBe(1);
    const [after] = await db
      .select({ identifier: billingUsageEvents.stripeMeterEventIdentifier })
      .from(billingUsageEvents);
    expect(after?.identifier).not.toBeNull();
  });
});
