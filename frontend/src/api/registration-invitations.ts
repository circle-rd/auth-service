import { apiFetch, USE_MOCK } from './client';
import type { RegistrationInvitation } from '@/types';

export interface CreateRegistrationInvitationResponse {
  invitation: RegistrationInvitation;
  inviteUrl: string;
  emailSent: boolean;
}

const MOCK_INVITATIONS: RegistrationInvitation[] = [];

export async function listRegistrationInvitations(applicationId: string): Promise<{ invitations: RegistrationInvitation[] }> {
  if (USE_MOCK) {
    return { invitations: MOCK_INVITATIONS.filter((i) => i.applicationId === applicationId) };
  }
  const qs = new URLSearchParams({ applicationId });
  return apiFetch<{ invitations: RegistrationInvitation[] }>(`/admin/registration-invitations?${qs}`);
}

export async function createRegistrationInvitation(body: { email: string; applicationId: string }): Promise<CreateRegistrationInvitationResponse> {
  if (USE_MOCK) {
    const invitation: RegistrationInvitation = {
      id: crypto.randomUUID(),
      email: body.email,
      applicationId: body.applicationId,
      invitedByUserId: 'mock',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      consumedAt: null,
      revokedAt: null,
    };
    MOCK_INVITATIONS.push(invitation);
    return { invitation, inviteUrl: '/complete-registration?token=mock-token', emailSent: false };
  }
  return apiFetch<CreateRegistrationInvitationResponse>('/admin/registration-invitations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function revokeRegistrationInvitation(id: string): Promise<{ invitation: RegistrationInvitation }> {
  if (USE_MOCK) {
    const invitation = MOCK_INVITATIONS.find((i) => i.id === id);
    if (invitation) invitation.revokedAt = new Date().toISOString();
    return { invitation: invitation! };
  }
  return apiFetch<{ invitation: RegistrationInvitation }>(`/admin/registration-invitations/${id}`, { method: 'DELETE' });
}

export async function resendRegistrationInvitation(id: string): Promise<CreateRegistrationInvitationResponse> {
  if (USE_MOCK) {
    const previous = MOCK_INVITATIONS.find((i) => i.id === id);
    if (!previous) throw new Error('Invitation not found');
    previous.revokedAt = new Date().toISOString();
    return createRegistrationInvitation({ email: previous.email, applicationId: previous.applicationId });
  }
  return apiFetch<CreateRegistrationInvitationResponse>(`/admin/registration-invitations/${id}/resend`, { method: 'POST' });
}
