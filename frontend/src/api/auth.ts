import { apiFetch, USE_MOCK } from './client';
import type { User, Session, MfaSetupResult, MfaBackupCodesResult, SignInResult } from '@/types';
import { MOCK_CURRENT_USER, MOCK_SESSIONS } from '@/mocks/data';

export interface AuthSession {
  user: User
  session: Session
}

export async function signOut(): Promise<void> {
  if (USE_MOCK) return;
  await apiFetch('/auth/sign-out', { method: 'POST' });
}

export async function getSession(): Promise<AuthSession | null> {
  if (USE_MOCK) {
    return {
      user: MOCK_CURRENT_USER,
      session: MOCK_SESSIONS[0],
    };
  }
  try {
    return await apiFetch<AuthSession>('/auth/get-session');
  } catch {
    return null;
  }
}

// ── Sign-in ────────────────────────────────────────────────────────────────
// BetterAuth's email sign-in returns either a session payload or, when the
// account has TOTP enabled, `{ twoFactorRedirect: true, twoFactorMethods: [...] }`.
// The endpoint sets a temporary 2FA cookie that is later consumed by the
// verify endpoint to issue the real session cookie.
export async function signInEmail(
  email: string,
  password: string,
): Promise<SignInResult> {
  return apiFetch<SignInResult>('/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

// ── Two-factor authentication (TOTP) ───────────────────────────────────────

export async function enableTwoFactor(password: string): Promise<MfaSetupResult> {
  return apiFetch<MfaSetupResult>('/auth/two-factor/enable', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function disableTwoFactor(password: string): Promise<void> {
  await apiFetch('/auth/two-factor/disable', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function verifyTotp(code: string): Promise<void> {
  await apiFetch('/auth/two-factor/verify-totp', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export async function verifyBackupCode(code: string): Promise<void> {
  await apiFetch('/auth/two-factor/verify-backup-code', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export async function generateBackupCodes(
  password: string,
): Promise<MfaBackupCodesResult> {
  return apiFetch<MfaBackupCodesResult>(
    '/auth/two-factor/generate-backup-codes',
    {
      method: 'POST',
      body: JSON.stringify({ password }),
    },
  );
}
