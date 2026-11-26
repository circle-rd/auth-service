import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { member } from "../db/auth-schema.js";
import { personalGatewayKeys } from "../db/gateway-key-schema.js";
import { ERR } from "../errors.js";
import { hashOpaqueToken } from "./oauth-tokens.js";
import {
  loadSharingApplication,
  type CallerApplication,
} from "./resources/application-scope.js";
import {
  isAccountActive,
  listActiveMemberships,
} from "./resources/identity-facts.js";

export const GATEWAY_KEY_RE = /^cgk_[A-Za-z0-9_-]{43}$/;

export interface GatewayKeySummary {
  id: string;
  label: string;
  organizationId: string | null;
  maskedKey: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CreatedGatewayKey extends GatewayKeySummary {
  key: string;
}

export interface ResolvedGatewayKey {
  keyId: string;
  userId: string;
  caller: CallerApplication;
  pool: string | null;
}

export function generateGatewayKey(): string {
  return `cgk_${randomBytes(32).toString("base64url")}`;
}

export function hashGatewayKey(key: string): string {
  return hashOpaqueToken(key);
}

export function maskGatewayKey(key: string): string {
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}

export async function isOrganizationMember(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
    )
    .limit(1);
  return row !== undefined;
}

export async function listActiveGatewayKeys(
  userId: string,
  applicationId: string,
): Promise<GatewayKeySummary[]> {
  return db
    .select({
      id: personalGatewayKeys.id,
      label: personalGatewayKeys.label,
      organizationId: personalGatewayKeys.organizationId,
      maskedKey: personalGatewayKeys.maskedKey,
      createdAt: personalGatewayKeys.createdAt,
      lastUsedAt: personalGatewayKeys.lastUsedAt,
    })
    .from(personalGatewayKeys)
    .where(
      and(
        eq(personalGatewayKeys.userId, userId),
        eq(personalGatewayKeys.applicationId, applicationId),
        isNull(personalGatewayKeys.revokedAt),
      ),
    )
    .orderBy(desc(personalGatewayKeys.createdAt));
}

export async function createGatewayKey(input: {
  userId: string;
  application: CallerApplication;
  organizationId: string | null;
  label: string;
}): Promise<CreatedGatewayKey> {
  if (!config.personalGatewayKeys.enabled) {
    throw ERR.KEY_004("Personal gateway keys are disabled");
  }

  const active = await db
    .select({ id: personalGatewayKeys.id })
    .from(personalGatewayKeys)
    .where(
      and(
        eq(personalGatewayKeys.userId, input.userId),
        isNull(personalGatewayKeys.revokedAt),
      ),
    );
  if (active.length >= config.personalGatewayKeys.maxPerUser) {
    throw ERR.KEY_005();
  }

  if (
    input.organizationId !== null &&
    !(await isOrganizationMember(input.userId, input.organizationId))
  ) {
    throw ERR.KEY_004("You are not a member of this organization");
  }

  const key = generateGatewayKey();
  const [row] = await db
    .insert(personalGatewayKeys)
    .values({
      userId: input.userId,
      applicationId: input.application.id,
      organizationId: input.organizationId,
      label: input.label,
      keyHash: hashGatewayKey(key),
      maskedKey: maskGatewayKey(key),
    })
    .returning({
      id: personalGatewayKeys.id,
      label: personalGatewayKeys.label,
      organizationId: personalGatewayKeys.organizationId,
      maskedKey: personalGatewayKeys.maskedKey,
      createdAt: personalGatewayKeys.createdAt,
      lastUsedAt: personalGatewayKeys.lastUsedAt,
    });
  if (!row) throw ERR.SRV_001("Could not store the gateway key");
  return { ...row, key };
}

export async function revokeGatewayKey(
  userId: string,
  keyId: string,
  applicationId: string,
): Promise<void> {
  const [row] = await db
    .select({
      id: personalGatewayKeys.id,
      revokedAt: personalGatewayKeys.revokedAt,
    })
    .from(personalGatewayKeys)
    .where(
      and(
        eq(personalGatewayKeys.id, keyId),
        eq(personalGatewayKeys.userId, userId),
        eq(personalGatewayKeys.applicationId, applicationId),
      ),
    )
    .limit(1);
  if (!row) throw ERR.KEY_002();
  if (row.revokedAt !== null) return;
  await db
    .update(personalGatewayKeys)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(personalGatewayKeys.id, keyId));
}

/**
 * Resolve a presented key to its user, application and pool. Every check that
 * admission depends on is re-read here, so revocation, a ban, a disabled
 * application or a lost membership takes effect on the next request.
 */
export async function resolveGatewayKey(
  key: string,
): Promise<ResolvedGatewayKey> {
  if (!config.personalGatewayKeys.enabled) throw ERR.KEY_001();
  if (!GATEWAY_KEY_RE.test(key)) throw ERR.KEY_001();

  const [row] = await db
    .select({
      id: personalGatewayKeys.id,
      userId: personalGatewayKeys.userId,
      applicationId: personalGatewayKeys.applicationId,
      organizationId: personalGatewayKeys.organizationId,
    })
    .from(personalGatewayKeys)
    .where(
      and(
        eq(personalGatewayKeys.keyHash, hashGatewayKey(key)),
        isNull(personalGatewayKeys.revokedAt),
      ),
    )
    .limit(1);
  if (!row) throw ERR.KEY_001();

  if (!(await isAccountActive(row.userId, new Date()))) {
    throw ERR.KEY_004("The account is not active");
  }
  const application = await loadSharingApplication(row.applicationId);
  if (!application) {
    throw ERR.KEY_004("The application is not available for sharing");
  }
  const memberships = await listActiveMemberships(row.userId, [application.id]);
  if (!memberships.has(application.id)) {
    throw ERR.KEY_004("You are not an active member of this application");
  }
  if (
    row.organizationId !== null &&
    !(await isOrganizationMember(row.userId, row.organizationId))
  ) {
    throw ERR.KEY_004("You are not an active member of this organization");
  }
  return {
    keyId: row.id,
    userId: row.userId,
    caller: { id: application.id, slug: application.slug },
    pool: row.organizationId,
  };
}

export async function touchGatewayKeyLastUsed(keyId: string): Promise<void> {
  const now = new Date();
  await db
    .update(personalGatewayKeys)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(personalGatewayKeys.id, keyId));
}
