import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { apiFetch, USE_MOCK } from './client';
import type { MfaMethod, MfaState, PasskeySummary } from '@/types';

interface MfaMethodsResponse {
  methods: MfaMethod[]
  totpRegistered: boolean
  passkeyCount: number
  backupCodesAvailable: boolean
}

export async function getMfaMethods(): Promise<MfaMethodsResponse> {
  if (USE_MOCK) {
    return {
      methods: [],
      totpRegistered: false,
      passkeyCount: 0,
      backupCodesAvailable: false,
    };
  }
  return apiFetch<MfaMethodsResponse>('/auth/mfa/methods');
}

export async function getMyMfaState(): Promise<MfaState> {
  if (USE_MOCK) {
    return {
      mfaEnabled: false,
      methods: [],
      totpRegistered: false,
      passkeyCount: 0,
      backupCodesAvailable: false,
    };
  }
  return apiFetch<MfaState>('/user/mfa');
}

export async function authenticateWithPasskey(): Promise<void> {
  if (USE_MOCK) throw new Error('Passkeys are not available in mock mode');
  const options = await apiFetch<PublicKeyCredentialRequestOptionsJSON>(
    '/auth/mfa/passkey/options',
  );
  const response = await startAuthentication({ optionsJSON: options });
  await verifyMfaPasskey(response);
}

export async function verifyMfaPasskey(
  response: AuthenticationResponseJSON,
): Promise<void> {
  await apiFetch('/auth/mfa/passkey/verify-authentication', {
    method: 'POST',
    body: JSON.stringify({ response }),
  });
}

export async function listPasskeys(): Promise<PasskeySummary[]> {
  if (USE_MOCK) return [];
  return apiFetch<PasskeySummary[]>('/auth/passkey/list-user-passkeys');
}

export async function registerPasskey(name?: string): Promise<PasskeySummary> {
  if (USE_MOCK) throw new Error('Passkeys are not available in mock mode');
  const options = await apiFetch<PublicKeyCredentialCreationOptionsJSON>(
    '/auth/passkey/generate-register-options',
  );
  const response: RegistrationResponseJSON = await startRegistration({
    optionsJSON: options,
  });
  return apiFetch<PasskeySummary>('/auth/passkey/verify-registration', {
    method: 'POST',
    body: JSON.stringify({ response, ...(name ? { name } : {}) }),
  });
}

export async function deletePasskey(id: string): Promise<void> {
  if (USE_MOCK) throw new Error('Passkeys are not available in mock mode');
  await apiFetch('/auth/passkey/delete-passkey', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  if (USE_MOCK) throw new Error('Passkeys are not available in mock mode');
  await apiFetch('/auth/passkey/update-passkey', {
    method: 'POST',
    body: JSON.stringify({ id, name }),
  });
}