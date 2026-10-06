import { apiFetch, USE_MOCK } from './client';
import type { User, UserApplicationDetail } from '@/types';
import { MOCK_USERS, MOCK_USER_APPLICATIONS } from '@/mocks/data';

export interface UsersListResponse {
  users: User[]
  total: number
  page: number
  limit: number
}

export interface UserDetailResponse {
  user: User
  applications: UserApplicationDetail[]
}

export interface CreateUserBody {
  name: string
  email: string
  password: string
  role: 'user' | 'admin' | 'superadmin'
}

export interface UpdateUserBody {
  name?: string
  role?: 'user' | 'admin' | 'superadmin'
  isMfaRequired?: boolean
  banned?: boolean
  banReason?: string | null
  banExpires?: string | null
  phone?: string | null
  company?: string | null
  position?: string | null
  address?: string | null
  image?: string | null
}

export async function listUsers(params: { page?: number; limit?: number; search?: string } = {}): Promise<UsersListResponse> {
  if (USE_MOCK) {
    let users = [...MOCK_USERS];
    if (params.search) {
      const s = params.search.toLowerCase();
      users = users.filter(u => u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s));
    }
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const start = (page - 1) * limit;
    return { users: users.slice(start, start + limit), total: users.length, page, limit };
  }
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.search) qs.set('search', params.search);
  return apiFetch<UsersListResponse>(`/admin/users?${qs}`);
}

export async function getUser(id: string): Promise<UserDetailResponse> {
  if (USE_MOCK) {
    const user = MOCK_USERS.find(u => u.id === id);
    if (!user) throw new Error('User not found');
    const apps: UserApplicationDetail[] = MOCK_USER_APPLICATIONS
      .filter(a => a.userId === id)
      .map(a => ({ id: a.applicationId, name: a.name ?? a.applicationId, slug: a.applicationId, icon: null, isActive: a.isActive, subscriptionPlanId: a.subscriptionPlanId, subscriptionPlanName: a.subscriptionPlanName ?? null, roles: a.roleId ? [{ id: a.roleId, name: a.roleId }] : [], lastLoginAt: a.lastLoginAt ?? null }));
    return { user, applications: apps };
  }
  return apiFetch<UserDetailResponse>(`/admin/users/${id}`);
}

export async function createUser(body: CreateUserBody): Promise<{ user: User }> {
  if (USE_MOCK) {
    const user: User = { ...body, id: `usr_${Math.random().toString(36).slice(2)}`, emailVerified: false, image: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), twoFactorEnabled: null, banned: null, banReason: null, banExpires: null, isMfaRequired: null, phone: null, company: null, position: null, address: null };
    MOCK_USERS.push(user);
    return { user };
  }
  return apiFetch<{ user: User }>('/admin/users', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateUser(id: string, body: UpdateUserBody): Promise<{ ok: true }> {
  if (USE_MOCK) {
    const idx = MOCK_USERS.findIndex(u => u.id === id);
    if (idx >= 0) Object.assign(MOCK_USERS[idx], body, { updatedAt: new Date().toISOString() });
    return { ok: true };
  }
  return apiFetch<{ ok: true }>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export interface UpdateMyProfileBody {
  name?: string
  phone?: string | null
  company?: string | null
  position?: string | null
  address?: string | null
  image?: string | null
}

export async function updateMyProfile(body: UpdateMyProfileBody): Promise<{ ok: true }> {
  if (USE_MOCK) {
    // Update the mock current user if it exists in MOCK_USERS
    return { ok: true };
  }
  return apiFetch<{ ok: true }>('/user/profile', { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteUser(id: string): Promise<void> {
  if (USE_MOCK) {
    const idx = MOCK_USERS.findIndex(u => u.id === id);
    if (idx >= 0) MOCK_USERS.splice(idx, 1);
    return;
  }
  return apiFetch<void>(`/admin/users/${id}`, { method: 'DELETE' });
}

export async function disableUser(id: string): Promise<{ ok: true }> {
  if (USE_MOCK) return { ok: true };
  return apiFetch<{ ok: true }>(`/admin/users/${id}/disable`, { method: 'POST' });
}

export async function enableUser(id: string): Promise<{ ok: true }> {
  if (USE_MOCK) return { ok: true };
  return apiFetch<{ ok: true }>(`/admin/users/${id}/enable`, { method: 'POST' });
}

/** Re-send the verification email; this also reverts the user to unverified. */
export async function sendVerificationEmail(id: string): Promise<{ ok: true }> {
  if (USE_MOCK) return { ok: true };
  return apiFetch<{ ok: true }>(`/admin/users/${id}/send-verification`, {
    method: 'POST',
  });
}

/** Mark a user's email as verified without them clicking the link. */
export async function markEmailVerified(id: string): Promise<{ ok: true }> {
  if (USE_MOCK) return { ok: true };
  return apiFetch<{ ok: true }>(`/admin/users/${id}/verify-email`, {
    method: 'POST',
  });
}

/**
 * Set a new password for a user without an e-mail round-trip. The server also
 * invalidates every session and OAuth token the target held, so this doubles as
 * the remediation path for a compromised account.
 */
export async function setUserPassword(
  id: string,
  newPassword: string,
): Promise<{ ok: true }> {
  if (USE_MOCK) return { ok: true };
  return apiFetch<{ ok: true }>(`/admin/users/${id}/set-password`, {
    method: 'POST',
    body: JSON.stringify({ newPassword }),
  });
}

export interface ImportUserRow {
  name: string;
  email: string;
  password?: string;
  role?: 'user' | 'admin';
}

export interface ImportResultRow {
  email: string;
  status: 'created' | 'error';
  message?: string;
  /** Present only when the row had no password (server-generated). */
  password?: string;
}

export async function importUsers(
  users: ImportUserRow[],
): Promise<{ results: ImportResultRow[]; created: number; failed: number }> {
  if (USE_MOCK) {
    return {
      results: users.map((u) => ({
        email: u.email,
        status: 'created' as const,
        password: u.password ? undefined : 'mock-temp-pass',
      })),
      created: users.length,
      failed: 0,
    };
  }
  return apiFetch<{ results: ImportResultRow[]; created: number; failed: number }>(
    '/admin/users/import',
    { method: 'POST', body: JSON.stringify({ users }) },
  );
}
