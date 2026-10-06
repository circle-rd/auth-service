import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { User, Session, MfaMethod } from '@/types';
import {
  getSession,
  signOut as apiSignOut,
  signInEmail as apiSignInEmail,
  verifyTotp as apiVerifyTotp,
  verifyBackupCode as apiVerifyBackupCode,
} from '@/api/auth';
import {
  canAdminTargetUser,
  canManageRole as canManageRoleByRank,
} from '@/utils/roles';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const session = ref<Session | null>(null);
  const loading = ref(false);
  const initialized = ref(false);

  // ── MFA challenge state ──────────────────────────────────────────────────
  // Set when sign-in returns `twoFactorRedirect: true`. The view layer
  // should swap to the MFA challenge form until the user verifies a code.
  const mfaPending = ref(false);
  const mfaMethods = ref<MfaMethod[]>([]);

  // Indicates the signed-in user must enable a second factor before being
  // allowed to use any downstream application. The auth-service UI itself
  // remains accessible so the user can complete the setup flow.
  const mfaSetupRequired = computed<boolean>(() => {
    if (!user.value) return false;
    return Boolean(user.value.isMfaRequired) && !user.value.twoFactorEnabled;
  });

  async function fetchSession() {
    loading.value = true;
    try {
      const result = await getSession();
      if (result) {
        user.value = result.user;
        session.value = result.session;
      } else {
        user.value = null;
        session.value = null;
      }
    } catch {
      user.value = null;
      session.value = null;
    } finally {
      loading.value = false;
      initialized.value = true;
    }
  }

  async function signInEmail(email: string, password: string): Promise<void> {
    const result = await apiSignInEmail(email, password);
    if (result.twoFactorRedirect) {
      mfaPending.value = true;
      mfaMethods.value = result.twoFactorMethods ?? ['totp'];
      return;
    }
    await fetchSession();
  }

  async function verifyMfaTotp(code: string): Promise<void> {
    await apiVerifyTotp(code);
    // Refresh the session BEFORE flipping `mfaPending`, otherwise the login
    // view would unmount the challenge form mid-promise and re-render the
    // email/password form for a frame, which the user perceives as a
    // "redirect back to login". The view layer is responsible for calling
    // `clearMfaPending()` after it has navigated away from /login.
    await fetchSession();
    if (!user.value) {
      throw new Error('Session was not established. Please try signing in again.');
    }
  }

  async function verifyMfaBackupCode(code: string): Promise<void> {
    await apiVerifyBackupCode(code);
    await fetchSession();
    if (!user.value) {
      throw new Error('Session was not established. Please try signing in again.');
    }
  }

  function clearMfaPending(): void {
    mfaPending.value = false;
    mfaMethods.value = [];
  }

  function cancelMfa(): void {
    mfaPending.value = false;
    mfaMethods.value = [];
  }

  async function logout() {
    try {
      await apiSignOut();
    } catch {
      // proceed even if API fails (e.g. session already expired)
    }
    user.value = null;
    session.value = null;
    mfaPending.value = false;
    mfaMethods.value = [];
  }

  function isAdmin(): boolean {
    return user.value?.role === 'admin' || user.value?.role === 'superadmin';
  }

  function isSuperAdmin(): boolean {
    return user.value?.role === 'superadmin';
  }

  /**
   * Mirrors the server's admin-route policy: a superadmin may manage anyone; an
   * admin may only manage non-admin users. Used to hide actions the caller
   * cannot perform.
   *
   * Delegates to the shared rank table (`@/utils/roles`) instead of re-writing
   * the comparison, so this gate cannot drift from `canAdminTargetUser`.
   */
  function canManageUser(targetRole: string | null | undefined): boolean {
    return canAdminTargetUser(user.value?.role, targetRole);
  }

  /**
   * STRICT policy, for the actions the server guards with `canManageRole` — the
   * password reset in particular. A superadmin may NOT act on a peer, so this
   * deliberately does not answer the same as `canManageUser`.
   */
  function canManageRole(targetRole: string | null | undefined): boolean {
    return canManageRoleByRank(user.value?.role, targetRole);
  }

  return {
    user,
    session,
    loading,
    initialized,
    mfaPending,
    mfaMethods,
    mfaSetupRequired,
    fetchSession,
    signInEmail,
    verifyMfaTotp,
    verifyMfaBackupCode,
    clearMfaPending,
    cancelMfa,
    logout,
    isAdmin,
    isSuperAdmin,
    canManageUser,
    canManageRole,
  };
});
