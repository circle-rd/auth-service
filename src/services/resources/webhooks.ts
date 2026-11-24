import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema.js";
import { resourceWebhookDeliveries } from "../../db/resource-schema.js";
import { ERR } from "../../errors.js";
import { assertNonLocalHost } from "../outbound-guard.js";

export const RESOURCE_WEBHOOK_EVENTS = [
  "resource.grant.created",
  "resource.grant.revoked",
  "resource.grant.updated",
  "resource.deleted",
] as const;
export type ResourceWebhookEvent = (typeof RESOURCE_WEBHOOK_EVENTS)[number];

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60 * 60 * 1_000;
const WORKER_INTERVAL_MS = 5_000;

export const resourceWebhookUrlSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "must be an https URL" });
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: "custom", message: "must not embed credentials" });
    }
    if (url.hash) {
      ctx.addIssue({ code: "custom", message: "must not have a fragment" });
    }
  });

export async function assertReachableResourceWebhookUrl(
  uri: string,
): Promise<void> {
  try {
    await assertNonLocalHost(new URL(uri).hostname);
  } catch (err) {
    throw ERR.APP_001(
      "resourceWebhookUrl must not target this host or a link-local address",
      { reason: err instanceof Error ? err.message : String(err) },
    );
  }
}

function secretKey(): Buffer {
  // Derived from the deployment secret so no new environment variable is
  // required; rotating BETTER_AUTH_SECRET invalidates stored webhook secrets.
  return createHash("sha256")
    .update(`${config.betterAuth.secret}:resource-webhook`)
    .digest();
}

export function generateResourceWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function encryptResourceWebhookSecret(secret: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptResourceWebhookSecret(value: string): string {
  const parts = value.split(".");
  const [nonce, tag, ciphertext] = parts;
  if (parts.length !== 3 || !nonce || !tag || !ciphertext) {
    throw ERR.SRV_001("Stored resource webhook secret is malformed");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      secretKey(),
      Buffer.from(nonce, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw ERR.SRV_001("Stored resource webhook secret cannot be decrypted");
  }
}

interface ClaimedDelivery {
  id: string;
  applicationId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

async function claimDueDelivery(): Promise<ClaimedDelivery | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(resourceWebhookDeliveries)
      .where(
        and(
          eq(resourceWebhookDeliveries.status, "pending"),
          lte(resourceWebhookDeliveries.nextAttemptAt, new Date()),
        ),
      )
      .orderBy(asc(resourceWebhookDeliveries.nextAttemptAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    const attempts = row.attempts + 1;
    await tx
      .update(resourceWebhookDeliveries)
      .set({ attempts, nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(resourceWebhookDeliveries.id, row.id));
    return {
      id: row.id,
      applicationId: row.applicationId,
      eventId: row.eventId,
      eventType: row.eventType,
      payload: row.payload,
      attempts,
    };
  });
}

function signature(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

async function deliver(claimed: ClaimedDelivery): Promise<void> {
  const [app] = await db
    .select({
      url: applications.resourceWebhookUrl,
      secret: applications.resourceWebhookSecret,
    })
    .from(applications)
    .where(eq(applications.id, claimed.applicationId))
    .limit(1);

  if (!app?.url || !app.secret) {
    await db
      .update(resourceWebhookDeliveries)
      .set({
        status: "delivered",
        deliveredAt: new Date(),
        lastError: "webhook disabled",
      })
      .where(eq(resourceWebhookDeliveries.id, claimed.id));
    return;
  }

  const body = JSON.stringify(claimed.payload);
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "auth-service-resource-webhook/1",
    "x-auth-service-event": claimed.eventType,
    "x-auth-service-delivery": claimed.eventId,
    "x-auth-service-signature": `t=${timestamp},v1=${signature(
      decryptResourceWebhookSecret(app.secret),
      timestamp,
      body,
    )}`,
  };

  let failure: string | null = null;
  try {
    await assertNonLocalHost(new URL(app.url).hostname);
    const response = await fetch(app.url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!response.ok) failure = `HTTP ${response.status}`;
  } catch (err) {
    failure = err instanceof Error ? err.name : "delivery failed";
  }

  if (failure === null) {
    await db
      .update(resourceWebhookDeliveries)
      .set({ status: "delivered", deliveredAt: new Date(), lastError: null })
      .where(eq(resourceWebhookDeliveries.id, claimed.id));
    return;
  }

  if (claimed.attempts >= MAX_ATTEMPTS) {
    await db
      .update(resourceWebhookDeliveries)
      .set({ status: "failed", lastError: failure })
      .where(eq(resourceWebhookDeliveries.id, claimed.id));
    return;
  }

  const delay = Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * 2 ** (claimed.attempts - 1),
  );
  await db
    .update(resourceWebhookDeliveries)
    .set({
      nextAttemptAt: new Date(Date.now() + delay),
      lastError: failure,
    })
    .where(eq(resourceWebhookDeliveries.id, claimed.id));
}

let worker: NodeJS.Timeout | null = null;
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let i = 0; i < 20; i += 1) {
      const claimed = await claimDueDelivery();
      if (!claimed) return;
      await deliver(claimed);
    }
  } finally {
    draining = false;
  }
}

export function startResourceWebhookWorker(): void {
  if (worker) return;
  worker = setInterval(() => void drain(), WORKER_INTERVAL_MS);
  worker.unref();
  void drain();
}

export async function countPendingResourceWebhooks(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(resourceWebhookDeliveries)
    .where(eq(resourceWebhookDeliveries.status, "pending"));
  return row?.count ?? 0;
}
