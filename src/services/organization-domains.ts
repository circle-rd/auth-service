import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { domainToASCII } from "node:url";
import { generateId } from "better-auth";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { member, organization, user as userTable } from "../db/auth-schema.js";
import { ERR } from "../errors.js";
import { logger } from "../logger.js";
import { sendOrganizationDomainUnverifiedEmail } from "./email.js";
import { ADMIN_ROOM, orgRoom, publishEvent, userRoom } from "./event-bus.js";

export const DOMAIN_TXT_PREFIX = "circle-auth-verification";
export const DOMAIN_TXT_HOST = "_circle-auth";
const DOMAIN_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DOMAIN_MONITOR_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DNS_TIMEOUT_MS = 5_000;

export const organizationDomainSchema = z
  .string()
  .trim()
  .max(253)
  .transform((value) => domainToASCII(value.toLowerCase().replace(/\.$/, "")))
  .pipe(
    z
      .string()
      .regex(
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
        "Use a bare hostname such as example.com",
      ),
  );

/** The exact email domain, lowercased and IDN-normalised. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const raw = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!raw) return null;
  return domainToASCII(raw) || null;
}

export function domainVerificationRecord(
  domain: string,
  token: string,
): { name: string; value: string } {
  return {
    name: `${DOMAIN_TXT_HOST}.${domain}`,
    value: `${DOMAIN_TXT_PREFIX}=${token}`,
  };
}

export function newDomainVerificationToken(): string {
  return randomBytes(24).toString("base64url");
}

async function resolveTxtWithTimeout(
  name: string,
): Promise<{ records: string[]; unavailable: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolveTxt(name),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("DNS lookup timed out")),
          DNS_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
    return {
      records: records.map((chunks) => chunks.join("")),
      unavailable: false,
    };
  } catch (err) {
    // ENODATA / ENOTFOUND are authoritative: the record is not published.
    // Anything else (timeout, SERVFAIL, network) is transient and must not be
    // allowed to revoke a previously verified domain.
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    return {
      records: [],
      unavailable: code !== "ENODATA" && code !== "ENOTFOUND",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type DomainProofResult = "valid" | "missing" | "unavailable";

/** Whether the TXT record carrying the organization's token is published. */
export async function checkDomainProof(
  domain: string,
  token: string,
): Promise<DomainProofResult> {
  const expected = `${DOMAIN_TXT_PREFIX}=${token}`;
  const result = await resolveTxtWithTimeout(`${DOMAIN_TXT_HOST}.${domain}`);
  if (result.unavailable) return "unavailable";
  return result.records.some((record) => record.trim() === expected)
    ? "valid"
    : "missing";
}

type OrganizationRow = typeof organization.$inferSelect;

/**
 * Ask for a fresh DNS challenge. Any previous proof and auto-enrollment are
 * revoked because the domain itself is what is being re-proven.
 */
export async function requestDomainVerification(
  organizationId: string,
): Promise<{
  organization: OrganizationRow;
  recordName: string;
  recordValue: string;
}> {
  const [row] = await db
    .select()
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  if (!row) throw ERR.ORG_001();
  if (!row.domain) throw ERR.ORG_006();

  const token = newDomainVerificationToken();
  const [updated] = await db
    .update(organization)
    .set({
      domainVerificationToken: token,
      domainVerifiedAt: null,
      domainVerifiedBy: null,
      domainLastCheckedAt: null,
      autoEnrollEnabled: false,
    })
    .where(eq(organization.id, organizationId))
    .returning();
  if (!updated) throw ERR.ORG_001();

  publishEvent("organization.changed", [ADMIN_ROOM, orgRoom(organizationId)]);

  const record = domainVerificationRecord(row.domain, token);
  return {
    organization: updated,
    recordName: record.name,
    recordValue: record.value,
  };
}

/** Validate the published TXT record and persist the proof. */
export async function verifyOrganizationDomain(
  organizationId: string,
  verifiedBy: string,
): Promise<OrganizationRow> {
  const [row] = await db
    .select()
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  if (!row) throw ERR.ORG_001();
  if (!row.domain) throw ERR.ORG_006();
  if (!row.domainVerificationToken) throw ERR.ORG_006();

  const [conflict] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(
      and(
        sql`lower(${organization.domain}) = ${row.domain.toLowerCase()}`,
        sql`${organization.domainVerifiedAt} is not null`,
        sql`${organization.id} <> ${organizationId}`,
      ),
    )
    .limit(1);
  if (conflict) throw ERR.ORG_008();

  const now = new Date();
  const proof = await checkDomainProof(row.domain, row.domainVerificationToken);
  if (proof === "unavailable") throw ERR.ORG_010();
  if (proof === "missing") {
    await db
      .update(organization)
      .set({ domainLastCheckedAt: now })
      .where(eq(organization.id, organizationId));
    throw ERR.ORG_007();
  }

  const [updated] = await db
    .update(organization)
    .set({
      domainVerifiedAt: now,
      domainVerifiedBy: verifiedBy,
      domainLastCheckedAt: now,
    })
    .where(
      and(
        eq(organization.id, organizationId),
        eq(organization.domain, row.domain),
        eq(organization.domainVerificationToken, row.domainVerificationToken),
      ),
    )
    .returning();
  if (!updated) {
    throw ERR.ORG_007(
      "The domain verification challenge changed; request a new challenge and retry",
    );
  }

  publishEvent("organization.changed", [ADMIN_ROOM, orgRoom(organizationId)]);
  return updated;
}

async function notifyOwnersOfDisabledAutoEnrollment(
  organizationId: string,
  organizationName: string,
  domain: string,
): Promise<void> {
  const owners = await db
    .select({ email: userTable.email })
    .from(member)
    .innerJoin(userTable, eq(member.userId, userTable.id))
    .where(
      and(eq(member.organizationId, organizationId), eq(member.role, "owner")),
    );

  await Promise.all(
    owners.map((owner) =>
      sendOrganizationDomainUnverifiedEmail(owner.email, {
        organizationName,
        domain,
      }).catch((err: unknown) => {
        logger.warn(
          { err: String(err), organizationId },
          "[organization-domain] failed to alert owner",
        );
      }),
    ),
  );
}

/**
 * Re-check a verified domain at most once per interval. A domain that no longer
 * proves ownership has its auto-enrollment disabled and its owners notified,
 * but keeps its historical verification timestamp.
 */
async function verifiedDomainStillValid(
  row: OrganizationRow,
  force = false,
): Promise<boolean> {
  if (!row.domain || !row.domainVerificationToken) return false;
  const now = new Date();
  if (
    !force &&
    row.domainLastCheckedAt &&
    now.getTime() - row.domainLastCheckedAt.getTime() <
      DOMAIN_RECHECK_INTERVAL_MS
  ) {
    return true;
  }

  const proof = await checkDomainProof(row.domain, row.domainVerificationToken);
  if (proof === "unavailable") {
    logger.warn(
      { organizationId: row.id, domain: row.domain },
      "[organization-domain] DNS lookup unavailable; keeping the proof",
    );
    return true;
  }
  if (proof === "valid") {
    await db
      .update(organization)
      .set({ domainLastCheckedAt: now })
      .where(eq(organization.id, row.id));
    return true;
  }

  // Disable atomically so concurrent sign-ups or multiple service instances do
  // not send duplicate owner alerts.
  const [disabled] = await db
    .update(organization)
    .set({ domainLastCheckedAt: now, autoEnrollEnabled: false })
    .where(
      and(
        eq(organization.id, row.id),
        eq(organization.autoEnrollEnabled, true),
      ),
    )
    .returning({ id: organization.id });
  if (!disabled) {
    await db
      .update(organization)
      .set({ domainLastCheckedAt: now })
      .where(eq(organization.id, row.id));
    return false;
  }

  publishEvent("organization.changed", [ADMIN_ROOM, orgRoom(row.id)]);
  void notifyOwnersOfDisabledAutoEnrollment(row.id, row.name, row.domain);
  return false;
}

/**
 * Periodic safety net: DNS proofs can be withdrawn at any time, so every
 * organization with auto-enrollment enabled is re-checked even when no new
 * account is being enrolled. Failures disable auto-enrollment and email the
 * owners.
 */
export async function revalidateAutoEnrollmentDomains(): Promise<number> {
  const rows = await db
    .select()
    .from(organization)
    .where(eq(organization.autoEnrollEnabled, true));
  let invalid = 0;
  for (const row of rows) {
    if (!(await verifiedDomainStillValid(row, true))) invalid += 1;
  }
  return invalid;
}

export function startAutoEnrollmentDomainMonitor(): () => void {
  const tick = (): void => {
    void revalidateAutoEnrollmentDomains().catch((err: unknown) => {
      logger.warn(
        { err: String(err) },
        "[organization-domain] periodic domain re-check failed",
      );
    });
  };
  const timer = setInterval(tick, DOMAIN_MONITOR_INTERVAL_MS);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}

/**
 * Attach a newly registered user to the organization that verified their email
 * domain. Only self-service registrations are eligible, the email must already
 * be verified, and a user who belongs to any organization is left untouched.
 */
export async function maybeAutoEnrollByEmailDomain(
  userId: string,
): Promise<OrganizationRow | null> {
  const [userRow] = await db
    .select({
      email: userTable.email,
      emailVerified: userTable.emailVerified,
      autoEnrollEligible: userTable.autoEnrollEligible,
    })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!userRow || !userRow.emailVerified || !userRow.autoEnrollEligible) {
    return null;
  }

  // Eligibility is a one-time sign-up marker: consume it before any lookup so a
  // later email change cannot turn an existing account into an auto-enrollment.
  await db
    .update(userTable)
    .set({ autoEnrollEligible: false })
    .where(eq(userTable.id, userId));

  const domain = emailDomain(userRow.email);
  if (!domain) return null;

  const [existingMembership] = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);
  if (existingMembership) return null;

  const [org] = await db
    .select()
    .from(organization)
    .where(
      and(
        sql`lower(${organization.domain}) = ${domain}`,
        eq(organization.autoEnrollEnabled, true),
        sql`${organization.domainVerifiedAt} is not null`,
      ),
    )
    .limit(1);
  if (!org) return null;

  if (!(await verifiedDomainStillValid(org))) return null;

  const [inserted] = await db
    .insert(member)
    .values({
      id: generateId(),
      organizationId: org.id,
      userId,
      role: "member",
      createdAt: new Date(),
    })
    .onConflictDoNothing({
      target: [member.organizationId, member.userId],
    })
    .returning({ id: member.id });
  if (!inserted) return null;

  publishEvent("organization.changed", [
    ADMIN_ROOM,
    orgRoom(org.id),
    userRoom(userId),
  ]);
  logger.info(
    { userId, organizationId: org.id, domain },
    "[organization-domain] auto-enrolled user",
  );
  return org;
}
