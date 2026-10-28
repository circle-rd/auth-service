import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Stripe from "stripe";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import {
  applications,
  subscriptionPlanPrices,
  subscriptionPlans,
  userApplications,
  userSubscriptions,
} from "../db/schema.js";
import { cleanDb } from "./helpers/db.js";
import { makeAuthServer, type AuthServerHandle } from "./helpers/server.js";
import { makeUserSession } from "./helpers/auth.js";
import { auth } from "../auth.js";
import { config } from "../config.js";
import { cacheStripeInvoice } from "../services/billing/invoices.js";

const mutableConfig = config as unknown as { templatesDir: string | null };
const originalDir = mutableConfig.templatesDir;

let handle: AuthServerHandle;

beforeAll(async () => {
  // No override directory: every page comes from the built-in templates under test.
  mutableConfig.templatesDir = null;
  handle = await makeAuthServer();
});

afterAll(async () => {
  mutableConfig.templatesDir = originalDir;
  await handle.cleanup();
});

beforeEach(async () => {
  await cleanDb();
  vi.restoreAllMocks();
  mutableConfig.templatesDir = null;
});

async function seed(billingMode: "none" | "delegated") {
  await db.insert(user).values({
    id: "u1",
    name: "Ada Lovelace",
    email: "u1@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const [app] = await db
    .insert(applications)
    .values({ name: "Acme Studio", slug: "acme", isActive: true, billingMode })
    .returning();
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({ applicationId: app!.id, name: "Pro", isDefault: false })
    .returning();
  await db.insert(subscriptionPlanPrices).values({
    planId: plan!.id,
    name: "Monthly",
    amount: "1000",
    currency: "eur",
    interval: "month",
    billingType: "fixed",
    stripePriceId: "price_pro",
  });
  return { app: app!, plan: plan! };
}

async function grantAccess(appId: string, planId: string) {
  await db.insert(userApplications).values({ userId: "u1", applicationId: appId });
  await db.insert(userSubscriptions).values({ userId: "u1", applicationId: appId, planId });
}

function signedIn() {
  vi.spyOn(auth.api, "getSession").mockResolvedValue(makeUserSession("u1") as never);
}

describe("delegated billing pages (integration)", () => {
  it("renders the subscribe page for a delegated application the user can access", async () => {
    const { app, plan } = await seed("delegated");
    await grantAccess(app.id, plan.id);
    signedIn();

    const res = await handle.app.inject({ method: "GET", url: "/billing/subscribe?client_id=acme" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Acme Studio");
    expect(res.body).toContain("Pro");
    expect(res.body).toContain("Current plan");
  });

  it("refuses an application that does not delegate billing", async () => {
    const { app, plan } = await seed("none");
    await grantAccess(app.id, plan.id);
    signedIn();

    const res = await handle.app.inject({ method: "GET", url: "/billing/invoices?client_id=acme" });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Billing is not available here");
  });

  it("refuses a user with no access to the application", async () => {
    await seed("delegated");
    signedIn();

    const res = await handle.app.inject({ method: "GET", url: "/billing/usage?client_id=acme" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("You do not have access to this application");
  });

  it("sends an anonymous visitor to the application's own sign-in", async () => {
    await seed("delegated");
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null as never);

    const res = await handle.app.inject({ method: "GET", url: "/billing/invoices?client_id=acme" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?client_id=acme&redirectTo=/);
  });

  it("lists the user's invoices, and never renders a non-https link", async () => {
    const { app, plan } = await seed("delegated");
    await grantAccess(app.id, plan.id);
    signedIn();
    await cacheStripeInvoice(
      {
        id: "in_1",
        object: "invoice",
        status: "paid",
        currency: "eur",
        amount_due: 1000,
        amount_paid: 1000,
        amount_remaining: 0,
        period_start: 1793000000,
        period_end: 1793002592,
        created: 1793000000,
        billing_reason: "subscription_cycle",
        hosted_invoice_url: "https://invoice.stripe.com/i/abc",
        invoice_pdf: "javascript:alert(1)",
        customer: null,
        metadata: { userId: "u1" },
        parent: {
          type: "subscription_details",
          subscription_details: { subscription: null, metadata: { applicationId: app.id } },
        },
      } as unknown as Stripe.Invoice,
      1793000000,
      { warn: () => undefined, debug: () => undefined },
    );

    const res = await handle.app.inject({ method: "GET", url: "/billing/invoices?client_id=acme" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("https://invoice.stripe.com/i/abc");
    expect(res.body).not.toContain("javascript:alert");
  });

  it("answers a static 500 when a page fails to render, never the SPA", async () => {
    const { app, plan } = await seed("delegated");
    await grantAccess(app.id, plan.id);
    signedIn();
    const dir = mkdtempSync(join(tmpdir(), "billing-pages-"));
    mkdirSync(join(dir, "default"), { recursive: true });
    writeFileSync(join(dir, "default", "invoices.html"), "<p><%= it.X </p>");
    mutableConfig.templatesDir = dir;
    const warn = vi.spyOn(handle.app.log, "warn");

    const res = await handle.app.inject({ method: "GET", url: "/billing/invoices?client_id=acme" });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain("could not be displayed");
    expect(res.body).not.toContain("<%=");
    const logged = warn.mock.calls.find((args) =>
      String(args[1] ?? "").includes("billing page failed to render"),
    );
    expect(logged).toBeDefined();
  });
});

describe("app-config exposes the billing mode", () => {
  it("reports delegated for an application that delegates billing", async () => {
    await seed("delegated");
    const res = await handle.app.inject({ method: "GET", url: "/api/app-config?client_id=acme" });
    expect(res.json()).toMatchObject({ billingMode: "delegated" });
  });

  it("reports none by default", async () => {
    await seed("none");
    const res = await handle.app.inject({ method: "GET", url: "/api/app-config?client_id=acme" });
    expect(res.json()).toMatchObject({ billingMode: "none" });
  });
});
