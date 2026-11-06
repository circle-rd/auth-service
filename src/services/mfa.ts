import { and, count, eq, exists, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { publishEvent } from "./event-bus.js";
import {
  account as accountTable,
  passkey as passkeyTable,
  twoFactor as twoFactorTable,
  user as userTable,
} from "../db/auth-schema.js";

/**
 * Multi-factor authentication is a single configuration made of independent
 * methods. `user.two_factor_enabled` is a cache of `mfaEnabled`, required by
 * BetterAuth's two-factor plugin to trigger the pending challenge. It is not a
 * TOTP-only flag and must only be written through `reconcileMfaFlag`.
 */

export type MfaMethod = "totp" | "passkey";

export interface MfaState {
  totpRegistered: boolean;
  passkeyCount: number;
  methods: MfaMethod[];
  mfaEnabled: boolean;
}

export type MfaRemovalBlockReason =
  "MFA_REQUIRED" | "LAST_AUTHENTICATION_METHOD";

export interface MfaUserState {
  isMfaRequired: boolean;
  twoFactorEnabled: boolean;
}

/**
 * Coerce loosely-typed BetterAuth user objects into the boolean state we need.
 * BetterAuth returns `additionalFields` as `Record<string, unknown>` because
 * they are dynamically declared in the `auth.ts` config.
 */
export function readMfaState(user: Record<string, unknown>): MfaUserState {
  return {
    isMfaRequired: Boolean(user.isMfaRequired),
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
  };
}

/**
 * Returns true when the user must enable a second factor before being granted
 * access to a downstream application via OAuth.
 *
 * `appRequiresMfa` is the per-application flag (`applications.is_mfa_required`).
 * Either flag being set is sufficient to require MFA.
 */
export function userMustSetupMfa(
  user: Record<string, unknown>,
  appRequiresMfa: boolean,
): boolean {
  const state = readMfaState(user);
  if (state.twoFactorEnabled) return false;
  return appRequiresMfa || state.isMfaRequired;
}

export function deriveMfaState(
  totpRegistered: boolean,
  passkeyCount: number,
  hasPassword = true,
): MfaState {
  const methods: MfaMethod[] = [];
  if (totpRegistered) methods.push("totp");
  if (passkeyCount > 0) methods.push("passkey");
  return {
    totpRegistered,
    passkeyCount,
    methods,
    // A passkey is only a second factor when a password is the first factor.
    // Social-only passkey owners keep it as a primary credential.
    mfaEnabled: totpRegistered || (passkeyCount > 0 && hasPassword),
  };
}

type MfaQueryExecutor = Pick<typeof db, "select">;

const activeTotpPredicate =
  or(eq(twoFactorTable.verified, true), isNull(twoFactorTable.verified)) ??
  sql`false`;

async function loadMfaState(
  executor: MfaQueryExecutor,
  userId: string,
): Promise<MfaState> {
  const [totp] = await executor
    .select({ id: twoFactorTable.id })
    .from(twoFactorTable)
    .where(and(eq(twoFactorTable.userId, userId), activeTotpPredicate))
    .limit(1);
  const [passkeys] = await executor
    .select({ value: count() })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId));
  const [credential] = await executor
    .select({ id: accountTable.id })
    .from(accountTable)
    .where(
      and(
        eq(accountTable.userId, userId),
        eq(accountTable.providerId, "credential"),
      ),
    )
    .limit(1);

  return deriveMfaState(
    Boolean(totp),
    Number(passkeys?.value ?? 0),
    Boolean(credential),
  );
}

export async function getMfaState(userId: string): Promise<MfaState> {
  return loadMfaState(db, userId);
}

/**
 * Recompute the derived BetterAuth flag from the actual factors. Locks the
 * user row so passkey registration/deletion and TOTP enable/disable cannot
 * race and leave the cache inconsistent.
 */
export async function reconcileMfaFlag(userId: string): Promise<MfaState> {
  let changed = false;
  const state = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ twoFactorEnabled: userTable.twoFactorEnabled })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .for("update");
    if (!locked) {
      throw new Error(`Cannot reconcile MFA for missing user ${userId}`);
    }

    const next = await loadMfaState(tx, userId);

    if (Boolean(locked.twoFactorEnabled) !== next.mfaEnabled) {
      await tx
        .update(userTable)
        .set({ twoFactorEnabled: next.mfaEnabled })
        .where(eq(userTable.id, userId));
      changed = true;
    }

    return next;
  });

  if (changed) publishEvent("user.changed");
  return state;
}

/**
 * One-time startup backfill for accounts that already own a factor but were
 * created before the flag became a derived MFA cache (notably passkey-only
 * accounts). Returns the number of users whose flag was flipped.
 */
export async function backfillMfaFlags(): Promise<number> {
  const hasPasskey = exists(
    db
      .select({ value: sql`1` })
      .from(passkeyTable)
      .where(eq(passkeyTable.userId, userTable.id)),
  );
  const hasCredential = exists(
    db
      .select({ value: sql`1` })
      .from(accountTable)
      .where(
        and(
          eq(accountTable.userId, userTable.id),
          eq(accountTable.providerId, "credential"),
        ),
      ),
  );
  const hasActiveTotp = exists(
    db
      .select({ value: sql`1` })
      .from(twoFactorTable)
      .where(and(eq(twoFactorTable.userId, userTable.id), activeTotpPredicate)),
  );
  const hasActiveFactor =
    or(hasActiveTotp, and(hasPasskey, hasCredential)) ?? sql`false`;

  const changed = await db
    .update(userTable)
    .set({ twoFactorEnabled: sql<boolean>`${hasActiveFactor}` })
    .where(
      sql`${userTable.twoFactorEnabled} IS DISTINCT FROM ${hasActiveFactor}`,
    )
    .returning({ id: userTable.id });

  return changed.length;
}

/**
 * Returns the reason a method cannot be removed, or null when removal is
 * allowed. Removing the last MFA method is always blocked when MFA is
 * required. Removing the last passkey is also blocked when it is the user's
 * only remaining way to authenticate.
 */
export async function checkMfaMethodRemoval(
  userId: string,
  method: MfaMethod,
): Promise<MfaRemovalBlockReason | null> {
  const state = await getMfaState(userId);
  // Several passkeys are still one method: removing one of them is safe.
  if (method === "passkey" && state.passkeyCount > 1) return null;

  const remaining = state.methods.filter((candidate) => candidate !== method);
  if (remaining.length > 0) return null;

  const [row] = await db
    .select({ isMfaRequired: userTable.isMfaRequired })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!row) throw new Error(`User ${userId} not found`);
  if (row.isMfaRequired) return "MFA_REQUIRED";

  if (method === "passkey") {
    const [account] = await db
      .select({ providerId: accountTable.providerId })
      .from(accountTable)
      .where(eq(accountTable.userId, userId))
      .limit(1);
    if (!account) return "LAST_AUTHENTICATION_METHOD";
  }

  return null;
}
