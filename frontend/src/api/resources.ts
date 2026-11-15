import { apiFetch } from './client';

export const RESOURCE_STATUSES = [
  'pending_validation',
  'validation_failed',
  'validated',
  'disabled',
] as const;
export type ResourceStatus = typeof RESOURCE_STATUSES[number];

export const RESOURCE_OWNER_TYPES = ['user', 'application'] as const;
export type ResourceOwnerType = typeof RESOURCE_OWNER_TYPES[number];

export const RESOURCE_SUBJECT_TYPES = ['user', 'organization', 'plan', 'everyone'] as const;
export type ResourceSubjectType = typeof RESOURCE_SUBJECT_TYPES[number];

export const OWNER_PERMISSIONS = ['resources:read', 'resources:manage', 'grants:manage'] as const;
export type OwnerPermission = typeof OWNER_PERMISSIONS[number];

export const RESOURCE_EVENT_DECISIONS = ['allow', 'deny'] as const;
export type ResourceEventDecision = typeof RESOURCE_EVENT_DECISIONS[number];

export const RESOURCE_EVENT_SOURCES = ['gateway', 'ssh', 'external', 'api'] as const;
export type ResourceEventSource = typeof RESOURCE_EVENT_SOURCES[number];

export interface OwnerApplication {
  id: string;
  name: string;
  slug: string;
  url: string | null;
  icon: string | null;
  permissions: OwnerPermission[];
  isAdmin: boolean;
}

export interface OwnerPlan {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
}

export interface OwnerMember {
  userId: string;
  name: string;
  email: string;
  isActive: boolean;
  roles: string[];
}

export interface ResourceScheme {
  scheme: string;
  source: 'builtin' | 'application';
  adapter: 'litellm' | 'ssh' | 'http' | 'file' | 'external';
  displayName: string;
  description: string | null;
  icon: string | null;
  validatorUrl: string | null;
  enabled: boolean;
  owned?: boolean;
}

export interface Resource {
  id: string;
  applicationId: string;
  applicationSlug: string;
  applicationName: string;
  scheme: string;
  schemeDisplayName?: string;
  uri: string;
  displayName: string;
  ownerType: ResourceOwnerType;
  ownerId: string;
  status: ResourceStatus;
  listed: boolean;
  metadata?: Record<string, unknown>;
  validationRequestedAt: string | null;
  validatedAt: string | null;
  validationError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceGrant {
  id: string;
  resourceId: string;
  subjectType: ResourceSubjectType;
  subjectId: string | null;
  permission: 'use';
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
  resourceUri?: string;
  resourceDisplayName?: string;
  applicationId?: string;
}

export interface ResourceInvitation {
  id: string;
  email: string;
  resourceId: string;
  resourceUri?: string;
  resourceDisplayName?: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
  state: 'pending' | 'consumed' | 'revoked' | 'expired';
}

export interface CatalogueApplication {
  slug: string;
  name: string;
}

export interface MemberApplication {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
}

export interface AccessibleResource {
  resourceId: string;
  resourceUri: string;
  scheme: string;
  displayName: string;
  applicationId: string;
  applicationSlug: string;
  applicationName: string;
  ownerType: ResourceOwnerType;
  ownerId: string;
  accessKind: 'owner' | 'admin' | 'grant';
  grantSubjectType?: ResourceSubjectType;
}

export interface AccessEvent {
  id: string;
  occurredAt: string;
  resourceId: string | null;
  uri: string;
  scheme: string;
  ownerType: ResourceOwnerType | null;
  ownerId: string | null;
  subjectType: ResourceSubjectType | null;
  subjectId: string | null;
  actorUserId: string | null;
  clientId: string;
  applicationId: string | null;
  decision: ResourceEventDecision;
  reasonClass: string | null;
  requestId: string | null;
  source: ResourceEventSource;
}

export interface UsageTotals {
  calls: number;
  unsupportedCalls: number;
  tokenlessCalls: number;
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
  uri: string;
  scheme: string;
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
  applicationId: string;
  scheme: string;
  locator?: string;
  displayName: string;
  metadata?: Record<string, unknown>;
}

export interface CreateAppResourceBody {
  scheme: string;
  locator?: string;
  displayName: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateResourceBody {
  displayName?: string;
  listed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CreateGrantBody {
  subjectType: ResourceSubjectType;
  subjectId?: string | null;
  expiresAt?: string | null;
}

export interface CreateInvitationBody {
  email: string;
  resourceId: string;
  ttlHours?: number;
}

export interface CreateInvitationResult {
  invitation: ResourceInvitation;
  inviteUrl: string;
  emailSent: boolean;
}

export interface CreateSchemeBody {
  scheme: string;
  displayName: string;
  description?: string | null;
  icon?: string | null;
  validatorUrl?: string | null;
}

export interface UpdateSchemeBody {
  displayName?: string;
  description?: string | null;
  icon?: string | null;
  validatorUrl?: string | null;
}

export interface UsageQuery {
  groupBy: 'user' | 'resource';
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AccessEventQuery {
  from?: string;
  to?: string;
  decision?: ResourceEventDecision;
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

export async function listResourceCatalogue(): Promise<{
  applications: CatalogueApplication[];
  resources: AccessibleResource[];
}> {
  return apiFetch('/user/resource-catalogue');
}

export async function listAccessibleResources(query: {
  applicationId?: string;
  scheme?: string;
} = {}): Promise<{ resources: AccessibleResource[] }> {
  return apiFetch(`/user/accessible-resources${queryString(query)}`);
}

export async function listOwnerApplications(): Promise<{ apps: OwnerApplication[] }> {
  return apiFetch('/user/apps');
}

export async function listMemberApplications(): Promise<{ applications: MemberApplication[] }> {
  return apiFetch('/user/resource-applications');
}

export async function listOwnerPlans(appId: string): Promise<{ plans: OwnerPlan[] }> {
  return apiFetch(`/user/apps/${appId}/plans`);
}

export async function listOwnerMembers(appId: string): Promise<{ members: OwnerMember[] }> {
  return apiFetch(`/user/apps/${appId}/members`);
}

export async function addOwnerMember(appId: string, email: string): Promise<{ member: OwnerMember & { created: boolean } }> {
  return apiFetch(`/user/apps/${appId}/members`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function listMemberSchemes(appId: string): Promise<{ schemes: ResourceScheme[] }> {
  return apiFetch(`/user/apps/${appId}/schemes`);
}

export async function listSchemeCatalog(appId: string): Promise<{ schemes: ResourceScheme[] }> {
  return apiFetch(`/user/apps/${appId}/resource-scheme-catalog`);
}

export async function createScheme(appId: string, body: CreateSchemeBody): Promise<{ scheme: ResourceScheme }> {
  return apiFetch(`/user/apps/${appId}/schemes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateScheme(appId: string, scheme: string, body: UpdateSchemeBody): Promise<{ scheme: ResourceScheme }> {
  return apiFetch(`/user/apps/${appId}/schemes/${scheme}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function enableScheme(appId: string, scheme: string): Promise<void> {
  await apiFetch(`/user/apps/${appId}/schemes/${scheme}/enable`, { method: 'PUT' });
}

export async function disableScheme(appId: string, scheme: string): Promise<void> {
  await apiFetch(`/user/apps/${appId}/schemes/${scheme}/enable`, { method: 'DELETE' });
}

export async function listAppResources(appId: string): Promise<{ resources: Resource[] }> {
  return apiFetch(`/user/apps/${appId}/resources`);
}

export async function createAppResource(appId: string, body: CreateAppResourceBody): Promise<{ resource: Resource }> {
  return apiFetch(`/user/apps/${appId}/resources`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function listMyResources(): Promise<{ resources: Resource[] }> {
  return apiFetch('/user/resources');
}

export async function createResource(body: CreateResourceBody): Promise<{ resource: Resource }> {
  return apiFetch('/user/resources', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getResource(resourceId: string): Promise<{ resource: Resource }> {
  return apiFetch(`/user/resources/${resourceId}`);
}

export async function updateResource(resourceId: string, body: UpdateResourceBody): Promise<{ resource: Resource }> {
  return apiFetch(`/user/resources/${resourceId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function disableResource(resourceId: string): Promise<{ resource: Resource }> {
  return apiFetch(`/user/resources/${resourceId}`, { method: 'DELETE' });
}

export async function requestValidation(resourceId: string): Promise<{ resource: Resource; validatorUrl: string | null }> {
  return apiFetch(`/user/resources/${resourceId}/validation-request`, { method: 'POST' });
}

export async function listResourceGrants(resourceId: string): Promise<{ grants: ResourceGrant[] }> {
  return apiFetch(`/user/resources/${resourceId}/grants`);
}

export async function createGrant(resourceId: string, body: CreateGrantBody): Promise<{ grant: ResourceGrant }> {
  return apiFetch(`/user/resources/${resourceId}/grants`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function revokeGrant(resourceId: string, grantId: string): Promise<{ grant: ResourceGrant }> {
  return apiFetch(`/user/resources/${resourceId}/grants/${grantId}`, { method: 'DELETE' });
}

export async function listAppGrants(appId: string): Promise<{ grants: ResourceGrant[] }> {
  return apiFetch(`/user/apps/${appId}/grants`);
}

export async function listInvitations(appId: string): Promise<{ invitations: ResourceInvitation[] }> {
  return apiFetch(`/user/apps/${appId}/invitations`);
}

export async function createInvitation(appId: string, body: CreateInvitationBody): Promise<CreateInvitationResult> {
  return apiFetch(`/user/apps/${appId}/invitations`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function revokeInvitation(appId: string, invitationId: string): Promise<{ invitation: ResourceInvitation }> {
  return apiFetch(`/user/apps/${appId}/invitations/${invitationId}`, { method: 'DELETE' });
}

export async function getOwnerUsage(appId: string, query: UsageQuery): Promise<OwnerUsage> {
  return apiFetch(`/user/apps/${appId}/usage${queryString({ ...query })}`);
}

export async function listAccessEvents(appId: string, query: AccessEventQuery = {}): Promise<{ events: AccessEvent[] }> {
  return apiFetch(`/user/apps/${appId}/access-events${queryString({ ...query })}`);
}

export async function acceptInvitation(token: string): Promise<{ grant: ResourceGrant }> {
  return apiFetch('/user/resource-invitations/accept', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}
