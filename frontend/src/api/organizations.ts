import { apiFetch, USE_MOCK } from './client';
import type { Organization, OrganizationMember, Invitation } from '@/types';
import { MOCK_ORGANIZATIONS } from '@/mocks/data';

export interface OrganizationsListResponse {
  organizations: Organization[];
  total: number;
  page: number;
  limit: number;
}

export interface OrganizationsListParams {
  page?: number;
  limit?: number;
  search?: string;
  sortBy?: 'name' | 'slug' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}

export async function listOrganizations(params: OrganizationsListParams = {}): Promise<OrganizationsListResponse> {
  if (USE_MOCK) {
    let orgs = [...MOCK_ORGANIZATIONS];
    if (params.search) {
      const s = params.search.toLowerCase();
      orgs = orgs.filter(o => o.name.toLowerCase().includes(s) || o.slug.toLowerCase().includes(s));
    }
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const start = (page - 1) * limit;
    return { organizations: orgs.slice(start, start + limit), total: orgs.length, page, limit };
  }
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.search) qs.set('search', params.search);
  if (params.sortBy) qs.set('sortBy', params.sortBy);
  if (params.sortOrder) qs.set('sortOrder', params.sortOrder);
  const query = qs.toString();
  return apiFetch<OrganizationsListResponse>(`/admin/organizations${query ? `?${query}` : ''}`);
}

export async function listOrganizationMembers(orgId: string, params: { limit?: number; offset?: number; search?: string } = {}): Promise<{ members: OrganizationMember[] }> {
  if (USE_MOCK) {
    const org = MOCK_ORGANIZATIONS.find(o => o.id === orgId);
    return { members: org?.members ?? [] };
  }
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.offset) qs.set('offset', String(params.offset));
  if (params.search) qs.set('search', params.search);
  const query = qs.toString();
  return apiFetch<{ members: OrganizationMember[] }>(`/admin/organizations/${orgId}/members${query ? `?${query}` : ''}`);
}

export async function createOrganization(body: { name: string; slug: string; logo?: string; metadata?: string }): Promise<{ organization: Organization }> {
  if (USE_MOCK) {
    const org: Organization = { id: `org_${Math.random().toString(36).slice(2)}`, name: body.name, slug: body.slug, logo: body.logo ?? null, createdAt: new Date().toISOString(), metadata: body.metadata ?? null, members: [] };
    MOCK_ORGANIZATIONS.push(org);
    return { organization: org };
  }
  return apiFetch<{ organization: Organization }>('/admin/organizations', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateOrganization(id: string, body: Partial<{ name: string; slug: string; logo: string; metadata: string }>): Promise<{ organization: Organization }> {
  if (USE_MOCK) {
    const idx = MOCK_ORGANIZATIONS.findIndex(o => o.id === id);
    if (idx >= 0) Object.assign(MOCK_ORGANIZATIONS[idx], body);
    return { organization: MOCK_ORGANIZATIONS[idx] };
  }
  return apiFetch<{ organization: Organization }>(`/admin/organizations/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteOrganization(id: string): Promise<void> {
  if (USE_MOCK) {
    const idx = MOCK_ORGANIZATIONS.findIndex(o => o.id === id);
    if (idx >= 0) MOCK_ORGANIZATIONS.splice(idx, 1);
    return;
  }
  return apiFetch<void>(`/admin/organizations/${id}`, { method: 'DELETE' });
}

export async function addMember(orgId: string, body: { userId: string; role: 'owner' | 'admin' | 'member' }): Promise<{ member: OrganizationMember }> {
  if (USE_MOCK) {
    const member: OrganizationMember = { id: `mem_${Math.random().toString(36).slice(2)}`, organizationId: orgId, userId: body.userId, role: body.role, createdAt: new Date().toISOString() };
    const org = MOCK_ORGANIZATIONS.find(o => o.id === orgId);
    if (org) { org.members ??= []; org.members.push(member); }
    return { member };
  }
  return apiFetch<{ member: OrganizationMember }>(`/admin/organizations/${orgId}/members`, { method: 'POST', body: JSON.stringify(body) });
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
  if (USE_MOCK) {
    const org = MOCK_ORGANIZATIONS.find(o => o.id === orgId);
    if (org?.members) org.members = org.members.filter(m => m.userId !== userId);
    return;
  }
  return apiFetch<void>(`/admin/organizations/${orgId}/members/${userId}`, { method: 'DELETE' });
}

export async function sendInvitation(orgId: string, body: { email: string; role: 'owner' | 'admin' | 'member' }): Promise<{ invitation: Invitation }> {
  if (USE_MOCK) {
    const inv: Invitation = { id: `inv_${Math.random().toString(36).slice(2)}`, organizationId: orgId, email: body.email, role: body.role, status: 'pending', expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), inviterId: 'usr_2wQx8mNpKvLrTbYcJdF3hA', createdAt: new Date().toISOString() };
    return { invitation: inv };
  }
  return apiFetch<{ invitation: Invitation }>(`/admin/organizations/${orgId}/invitations`, { method: 'POST', body: JSON.stringify(body) });
}

export async function cancelInvitation(orgId: string, invitationId: string): Promise<void> {
  if (USE_MOCK) return;
  return apiFetch<void>(`/admin/organizations/${orgId}/invitations/${invitationId}`, { method: 'DELETE' });
}

/** User-facing: returns the orgs the logged-in user is a member of */
export async function getMyOrganizations(): Promise<{ organizations: Array<Organization & { role: string }> }> {
  if (USE_MOCK) return { organizations: [] };
  return apiFetch<{ organizations: Array<Organization & { role: string }> }>('/user/organizations');
}

