import { apiFetch, USE_MOCK } from './client';
import type { User, UserApplication } from '@/types';
import { MOCK_USERS, MOCK_USER_APPLICATIONS } from '@/mocks/data';

export interface UsersListResponse {
  users: User[]
  total: number
  page: number
  limit: number
}

export interface UserDetailResponse {
  user: User
  applications: UserApplication[]
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
    return { user, applications: MOCK_USER_APPLICATIONS.filter(a => a.userId === id) };
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
