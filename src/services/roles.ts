/**
 * Platform role ranking shared by the auth instance and the admin routes.
 *
 * Kept in its own module (rather than `auth.ts`) so route plugins can reuse the
 * hierarchy without importing the BetterAuth instance.
 */

const ROLE_RANK: Record<string, number> = { user: 0, admin: 1, superadmin: 2 };

export function roleRank(role: string | null | undefined): number {
  return role ? (ROLE_RANK[role] ?? 0) : 0;
}

/** A caller may only manage users that strictly outrank below them. */
export function canManageRole(
  callerRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  return roleRank(callerRole) > roleRank(targetRole);
}

/**
 * Admin-route policy, intentionally looser than `canManageRole`: a superadmin
 * may target anyone (including other superadmins, which the last-superadmin
 * guard in the delete route relies on) while an admin may only target
 * non-admin users.
 */
export function canAdminTargetUser(
  callerRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  return callerRole === "superadmin" || roleRank(targetRole) < 1;
}
