/**
 * Platform role ranking — the client-side mirror of `src/services/roles.ts`.
 *
 * The server is the authority: `src/services/roles.ts` holds the same table and
 * the same two predicates. The SPA is a separate package (the root tsconfig
 * excludes `frontend/`, and there is no shared workspace package), so the rule
 * is mirrored here in ONE place per side rather than re-derived at each call
 * site — a UI gate that disagreed with the server would either hide an action
 * the server would accept or offer one it refuses with a 403.
 */

const ROLE_RANK: Record<string, number> = { user: 0, admin: 1, superadmin: 2 };

export function roleRank(role: string | null | undefined): number {
  return role ? (ROLE_RANK[role] ?? 0) : 0;
}

/**
 * Strict policy — a caller may only act on a user who ranks strictly below
 * them. Mirrors `canManageRole` in `src/services/roles.ts`; the server applies
 * it to password resets (and to the native admin endpoints).
 */
export function canManageRole(
  callerRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  return roleRank(callerRole) > roleRank(targetRole);
}

/**
 * Loose admin-route policy — a superadmin may target anyone. Mirrors
 * `canAdminTargetUser` in `src/services/roles.ts`; used by the neighbouring
 * admin actions (edit, ban, verify), NOT by the password reset.
 */
export function canAdminTargetUser(
  callerRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  return callerRole === 'superadmin' || roleRank(targetRole) < 1;
}
