import { apiFetch } from './client';

export const RESOURCE_TYPES = ['model', 'workflow', 'mcp_agent', 'https_endpoint'] as const;
export type ResourceType = typeof RESOURCE_TYPES[number];

export const RESOURCE_STATUSES = ['draft', 'published', 'disabled'] as const;
export type ResourceStatus = typeof RESOURCE_STATUSES[number];

export const RESOURCE_VISIBILITIES = ['invited_only', 'public_catalog'] as const;
export type ResourceVisibility = typeof RESOURCE_VISIBILITIES[number];

export const OWNER_PERMISSIONS = ['resources:read', 'resources:manage', 'grants:manage'] as const;
export type OwnerPermission = typeof OWNER_PERMISSIONS[number];

export interface OwnerApplication {
  id: string;
  name: string;
  slug: string;
  url: string | null;
  icon: string | null;
  permissions: OwnerPermission[];
}

export interface OwnerPlan {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
}

export interface SharedResource {
  id: string;
  ownerApplicationId: string;
  resourceType: ResourceType;
  key: string;
  displayName: string;
  upstreamRef: string | null;
  status: ResourceStatus;
  visibility: ResourceVisibility;
  defaultPlanId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceGrant {
  id: string;
  subjectId: string;
  ownerApplicationId: string;
  resourceId: string | null;
  planId: string;
  planName: string;
  allowedClientIds: string[] | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ResourceInvitation {
  id: string;
  email: string;
  planId: string;
  planName: string;
  resourceId: string | null;
  resourceName: string | null;
  allowedClientIds: string[] | null;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
  state: 'pending' | 'consumed' | 'revoked' | 'expired';
}

export interface OwnerMember {
  userId: string;
  name: string;
  email: string;
  isActive: boolean;
  roles: string[];
}

export interface UsageTotals {
  calls: number;
  unsupportedCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: string;
}

export interface UsageUserRow extends UsageTotals {
  subjectId: string;
}

export interface UsageResourceRow extends UsageTotals {
  resourceId: string;
  resourceType: ResourceType;
  resourceKey: string;
  displayName: string | null;
}

export interface OwnerUsage {
  groupBy: 'user' | 'resource';
  from: string;
  to: string;
  items: UsageUserRow[] | UsageResourceRow[];
  totals: UsageTotals;
  hasMore: boolean;
  nextOffset: number | null;
}

export interface CreateResourceBody {
  resourceType: ResourceType;
  slug: string;
  displayName: string;
  upstreamRef?: string | null;
  status?: ResourceStatus;
  visibility?: ResourceVisibility;
}

export type UpdateResourceBody = Partial<CreateResourceBody>;

export interface UpdateGrantBody {
  resourceId?: string | null;
  planId?: string;
  allowedClientIds?: string[] | null;
  expiresAt?: string | null;
}

export interface CreateInvitationBody {
  email: string;
  planId: string;
  resourceId?: string | null;
  allowedClientIds?: string[] | null;
  ttlHours?: number;
}

export interface CreateInvitationResult {
  invitation: ResourceInvitation;
  inviteUrl: string;
  emailSent: boolean;
}

export interface UsageQuery {
  groupBy: 'user' | 'resource';
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export async function listOwnerApplications(): Promise<{ apps: OwnerApplication[] }> {
  return apiFetch<{ apps: OwnerApplication[] }>('/user/apps');
}

export async function listOwnerPlans(appId: string): Promise<{ plans: OwnerPlan[] }> {
  return apiFetch<{ plans: OwnerPlan[] }>(`/user/apps/${appId}/plans`);
}

export async function listSharedResources(appId: string): Promise<{ resources: SharedResource[] }> {
  return apiFetch<{ resources: SharedResource[] }>(`/user/apps/${appId}/shared-resources`);
}

export async function createSharedResource(appId: string, body: CreateResourceBody): Promise<{ resource: SharedResource }> {
  return apiFetch<{ resource: SharedResource }>(`/user/apps/${appId}/shared-resources`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateSharedResource(
  appId: string,
  resourceId: string,
  body: UpdateResourceBody,
): Promise<{ resource: SharedResource }> {
  return apiFetch<{ resource: SharedResource }>(`/user/apps/${appId}/shared-resources/${resourceId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function disableSharedResource(appId: string, resourceId: string): Promise<{ resource: SharedResource }> {
  return apiFetch<{ resource: SharedResource }>(`/user/apps/${appId}/shared-resources/${resourceId}`, {
    method: 'DELETE',
  });
}

export async function listGrants(appId: string): Promise<{ grants: ResourceGrant[] }> {
  return apiFetch<{ grants: ResourceGrant[] }>(`/user/apps/${appId}/grants`);
}

export async function updateGrant(appId: string, grantId: string, body: UpdateGrantBody): Promise<{ grant: ResourceGrant }> {
  return apiFetch<{ grant: ResourceGrant }>(`/user/apps/${appId}/grants/${grantId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function revokeGrant(appId: string, grantId: string): Promise<{ grant: ResourceGrant }> {
  return apiFetch<{ grant: ResourceGrant }>(`/user/apps/${appId}/grants/${grantId}`, {
    method: 'DELETE',
  });
}

export async function listInvitations(appId: string): Promise<{ invitations: ResourceInvitation[] }> {
  return apiFetch<{ invitations: ResourceInvitation[] }>(`/user/apps/${appId}/invitations`);
}

export async function createInvitation(appId: string, body: CreateInvitationBody): Promise<CreateInvitationResult> {
  return apiFetch<CreateInvitationResult>(`/user/apps/${appId}/invitations`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function revokeInvitation(appId: string, invitationId: string): Promise<{ invitation: ResourceInvitation }> {
  return apiFetch<{ invitation: ResourceInvitation }>(`/user/apps/${appId}/invitations/${invitationId}`, {
    method: 'DELETE',
  });
}

export async function listMembers(appId: string): Promise<{ members: OwnerMember[] }> {
  return apiFetch<{ members: OwnerMember[] }>(`/user/apps/${appId}/members`);
}

export async function getOwnerUsage(appId: string, query: UsageQuery): Promise<OwnerUsage> {
  return apiFetch<OwnerUsage>(`/user/apps/${appId}/usage${queryString({ ...query })}`);
}

export async function acceptInvitation(token: string): Promise<{ grant: ResourceGrant }> {
  return apiFetch<{ grant: ResourceGrant }>('/user/resource-invitations/accept', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}
