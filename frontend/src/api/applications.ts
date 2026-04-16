import { apiFetch, USE_MOCK } from './client';
import type { Application, ApplicationCreateResponse, UserApplication, AppRole, AppPermission, SubscriptionPlan, SubscriptionPlanPrice } from '@/types';
import { MOCK_APPLICATIONS, MOCK_ROLES, MOCK_PERMISSIONS, MOCK_PLANS, MOCK_USER_APPLICATIONS } from '@/mocks/data';

export async function listApplications(): Promise<{ applications: Application[] }> {
  if (USE_MOCK) return { applications: MOCK_APPLICATIONS };
  return apiFetch<{ applications: Application[] }>('/admin/applications');
}

export async function getApplication(id: string): Promise<{ application: Application }> {
  if (USE_MOCK) {
    const application = MOCK_APPLICATIONS.find(a => a.id === id);
    if (!application) throw new Error('Application not found');
    return { application };
  }
  return apiFetch<{ application: Application }>(`/admin/applications/${id}`);
}

export interface CreateApplicationBody {
  name: string
  slug: string
  description?: string
  isActive?: boolean
  isPublic?: boolean
  skipConsent?: boolean
  isMfaRequired?: boolean
  allowRegister?: boolean
  allowedScopes?: string[]
  redirectUris?: string[]
  url?: string
  icon?: string
  enabledSocialProviders?: string[] | null
}

export async function createApplication(body: CreateApplicationBody): Promise<ApplicationCreateResponse> {
  if (USE_MOCK) {
    const app: Application = {
      id: crypto.randomUUID(),
      name: body.name,
      slug: body.slug,
      description: body.description ?? null,
      isActive: body.isActive ?? true,
      skipConsent: body.skipConsent ?? false,
      isMfaRequired: body.isMfaRequired ?? false,
      allowRegister: body.allowRegister ?? true,
      allowedScopes: body.allowedScopes ?? ['openid'],
      redirectUris: body.redirectUris ?? [],
      isPublic: body.isPublic ?? false,
      url: body.url ?? null,
      icon: body.icon ?? null,
      enabledSocialProviders: body.enabledSocialProviders ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    MOCK_APPLICATIONS.push(app);
    return { application: app, clientId: app.slug, clientSecret: body.isPublic ? undefined : 'cs_mock_' + Math.random().toString(36).slice(2, 18) };
  }
  return apiFetch<ApplicationCreateResponse>('/admin/applications', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateApplication(id: string, body: Partial<CreateApplicationBody>): Promise<{ application: Application }> {
  if (USE_MOCK) {
    const idx = MOCK_APPLICATIONS.findIndex(a => a.id === id);
    if (idx >= 0) Object.assign(MOCK_APPLICATIONS[idx], body, { updatedAt: new Date().toISOString() });
    return { application: MOCK_APPLICATIONS[idx] };
  }
  return apiFetch<{ application: Application }>(`/admin/applications/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteApplication(id: string): Promise<void> {
  if (USE_MOCK) {
    const idx = MOCK_APPLICATIONS.findIndex(a => a.id === id);
    if (idx >= 0) MOCK_APPLICATIONS.splice(idx, 1);
    return;
  }
  return apiFetch<void>(`/admin/applications/${id}`, { method: 'DELETE' });
}

export async function rotateSecret(id: string): Promise<{ clientSecret: string }> {
  if (USE_MOCK) return { clientSecret: 'cs_mock_' + Math.random().toString(36).slice(2, 18) };
  return apiFetch<{ clientSecret: string }>(`/admin/applications/${id}/rotate-secret`, { method: 'POST' });
}

export async function listAppUsers(appId: string): Promise<{ users: UserApplication[] }> {
  if (USE_MOCK) return { users: MOCK_USER_APPLICATIONS.filter(u => u.applicationId === appId) };
  return apiFetch<{ users: UserApplication[] }>(`/admin/applications/${appId}/users`);
}

export async function grantAppAccess(appId: string, body: { userId: string; roleId?: string }): Promise<{ access: UserApplication }> {
  if (USE_MOCK) {
    const access: UserApplication = { userId: body.userId, applicationId: appId, isActive: true, subscriptionPlanId: null, createdAt: new Date().toISOString(), name: null, email: null, roleId: body.roleId ?? null };
    MOCK_USER_APPLICATIONS.push(access);
    return { access };
  }
  return apiFetch<{ access: UserApplication }>(`/admin/applications/${appId}/users`, { method: 'POST', body: JSON.stringify(body) });
}

export async function updateAppAccess(appId: string, userId: string, body: { isActive?: boolean; roleId?: string; subscriptionPlanId?: string }): Promise<{ ok: true }> {
  if (USE_MOCK) {
    const ua = MOCK_USER_APPLICATIONS.find(u => u.applicationId === appId && u.userId === userId);
    if (ua) Object.assign(ua, body);
    return { ok: true };
  }
  return apiFetch<{ ok: true }>(`/admin/applications/${appId}/users/${userId}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function revokeAppAccess(appId: string, userId: string): Promise<void> {
  if (USE_MOCK) {
    const idx = MOCK_USER_APPLICATIONS.findIndex(u => u.applicationId === appId && u.userId === userId);
    if (idx >= 0) MOCK_USER_APPLICATIONS.splice(idx, 1);
    return;
  }
  return apiFetch<void>(`/admin/applications/${appId}/users/${userId}`, { method: 'DELETE' });
}

export async function assignSubscription(appId: string, userId: string, body: { planId: string }): Promise<{ ok: true }> {
  if (USE_MOCK) return { ok: true };
  return apiFetch<{ ok: true }>(`/admin/applications/${appId}/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ subscriptionPlanId: body.planId }) });
}

export async function removeSubscription(appId: string, userId: string): Promise<{ ok: true }> {
  if (USE_MOCK) return { ok: true };
  return apiFetch<{ ok: true }>(`/admin/applications/${appId}/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ subscriptionPlanId: null }) });
}

export async function listRoles(appId: string): Promise<{ roles: AppRole[] }> {
  if (USE_MOCK) return { roles: MOCK_ROLES.filter(r => r.applicationId === appId) };
  return apiFetch<{ roles: AppRole[] }>(`/admin/applications/${appId}/roles`);
}

export async function createRole(appId: string, body: { name: string; description?: string; isDefault?: boolean }): Promise<{ role: AppRole }> {
  if (USE_MOCK) {
    const role: AppRole = { id: crypto.randomUUID(), applicationId: appId, name: body.name, description: body.description ?? null, isDefault: body.isDefault ?? false, createdAt: new Date().toISOString(), permissionIds: [] };
    MOCK_ROLES.push(role);
    return { role };
  }
  return apiFetch<{ role: AppRole }>(`/admin/applications/${appId}/roles`, { method: 'POST', body: JSON.stringify(body) });
}

export async function updateRole(appId: string, roleId: string, body: Partial<{ name: string; description: string; isDefault: boolean }>): Promise<{ role: AppRole }> {
  if (USE_MOCK) {
    const idx = MOCK_ROLES.findIndex(r => r.id === roleId);
    if (idx >= 0) Object.assign(MOCK_ROLES[idx], body);
    return { role: MOCK_ROLES[idx] };
  }
  return apiFetch<{ role: AppRole }>(`/admin/applications/${appId}/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteRole(appId: string, roleId: string): Promise<void> {
  if (USE_MOCK) {
    const idx = MOCK_ROLES.findIndex(r => r.id === roleId);
    if (idx >= 0) MOCK_ROLES.splice(idx, 1);
    return;
  }
  return apiFetch<void>(`/admin/applications/${appId}/roles/${roleId}`, { method: 'DELETE' });
}

export async function listPermissions(appId: string): Promise<{ permissions: AppPermission[] }> {
  if (USE_MOCK) return { permissions: MOCK_PERMISSIONS.filter(p => p.applicationId === appId) };
  return apiFetch<{ permissions: AppPermission[] }>(`/admin/applications/${appId}/permissions`);
}

export async function createPermission(appId: string, body: { resource: string; action: 'read' | 'write' }): Promise<{ permission: AppPermission }> {
  if (USE_MOCK) {
    const perm: AppPermission = { id: crypto.randomUUID(), applicationId: appId, resource: body.resource, action: body.action, createdAt: new Date().toISOString() };
    MOCK_PERMISSIONS.push(perm);
    return { permission: perm };
  }
  return apiFetch<{ permission: AppPermission }>(`/admin/applications/${appId}/permissions`, { method: 'POST', body: JSON.stringify(body) });
}

export async function deletePermission(appId: string, permId: string): Promise<void> {
  if (USE_MOCK) {
    const idx = MOCK_PERMISSIONS.findIndex(p => p.id === permId);
    if (idx >= 0) MOCK_PERMISSIONS.splice(idx, 1);
    return;
  }
  return apiFetch<void>(`/admin/applications/${appId}/permissions/${permId}`, { method: 'DELETE' });
}

export async function assignPermissionToRole(appId: string, roleId: string, permId: string): Promise<{ ok: true }> {
  if (USE_MOCK) {
    const role = MOCK_ROLES.find(r => r.id === roleId);
    if (role && !role.permissionIds.includes(permId)) role.permissionIds.push(permId);
    return { ok: true };
  }
  return apiFetch<{ ok: true }>(`/admin/applications/${appId}/roles/${roleId}/permissions/${permId}`, { method: 'POST' });
}

export async function removePermissionFromRole(appId: string, roleId: string, permId: string): Promise<void> {
  if (USE_MOCK) {
    const role = MOCK_ROLES.find(r => r.id === roleId);
    if (role) role.permissionIds = role.permissionIds.filter(p => p !== permId);
    return;
  }
  return apiFetch<void>(`/admin/applications/${appId}/roles/${roleId}/permissions/${permId}`, { method: 'DELETE' });
}

export async function listPlans(appId: string): Promise<{ plans: SubscriptionPlan[] }> {
  if (USE_MOCK) return { plans: MOCK_PLANS.filter(p => p.applicationId === appId) };
  return apiFetch<{ plans: SubscriptionPlan[] }>(`/admin/applications/${appId}/plans`);
}

export async function createPlan(appId: string, body: { name: string; description?: string; features?: Record<string, unknown>; isDefault?: boolean }): Promise<{ plan: SubscriptionPlan }> {
  if (USE_MOCK) {
    const plan: SubscriptionPlan = { id: crypto.randomUUID(), applicationId: appId, name: body.name, description: body.description ?? null, stripeProductId: null, features: body.features ?? {}, isDefault: body.isDefault ?? false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), prices: [] };
    MOCK_PLANS.push(plan);
    return { plan };
  }
  return apiFetch<{ plan: SubscriptionPlan }>(`/admin/applications/${appId}/plans`, { method: 'POST', body: JSON.stringify(body) });
}

export async function updatePlan(appId: string, planId: string, body: Partial<{ name: string; description: string; features: Record<string, unknown>; isDefault: boolean }>): Promise<{ plan: SubscriptionPlan }> {
  if (USE_MOCK) {
    const idx = MOCK_PLANS.findIndex(p => p.id === planId);
    if (idx >= 0) Object.assign(MOCK_PLANS[idx], body, { updatedAt: new Date().toISOString() });
    return { plan: MOCK_PLANS[idx] };
  }
  return apiFetch<{ plan: SubscriptionPlan }>(`/admin/applications/${appId}/plans/${planId}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deletePlan(appId: string, planId: string): Promise<void> {
  if (USE_MOCK) {
    const idx = MOCK_PLANS.findIndex(p => p.id === planId);
    if (idx >= 0) MOCK_PLANS.splice(idx, 1);
    return;
  }
  return apiFetch<void>(`/admin/applications/${appId}/plans/${planId}`, { method: 'DELETE' });
}

export async function createPrice(appId: string, planId: string, body: { name: string; amount: string; currency: string; interval: 'month' | 'year' | 'one_time' }): Promise<{ price: SubscriptionPlanPrice }> {
  if (USE_MOCK) {
    const price: SubscriptionPlanPrice = { id: crypto.randomUUID(), planId, name: body.name, amount: body.amount, currency: body.currency, interval: body.interval, stripePriceId: null, createdAt: new Date().toISOString() };
    const plan = MOCK_PLANS.find(p => p.id === planId);
    if (plan) plan.prices.push(price);
    return { price };
  }
  return apiFetch<{ price: SubscriptionPlanPrice }>(`/admin/applications/${appId}/plans/${planId}/prices`, { method: 'POST', body: JSON.stringify(body) });
}

export async function deletePrice(appId: string, planId: string, priceId: string): Promise<void> {
  if (USE_MOCK) {
    const plan = MOCK_PLANS.find(p => p.id === planId);
    if (plan) plan.prices = plan.prices.filter(pr => pr.id !== priceId);
    return;
  }
  return apiFetch<void>(`/admin/applications/${appId}/plans/${planId}/prices/${priceId}`, { method: 'DELETE' });
}
