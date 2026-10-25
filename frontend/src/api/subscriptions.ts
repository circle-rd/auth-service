import { apiFetch, USE_MOCK } from './client';
import type { UserSubscriptionsResponse } from '@/types';
import { MOCK_APPLICATIONS, MOCK_PLANS, MOCK_USER_APPLICATIONS, MOCK_SERVICES_CONFIG } from '@/mocks/data';

/**
 * The current user's application access list with plan details, the plans
 * available per application, and whether Stripe is configured.
 */
export async function getMySubscriptions(): Promise<UserSubscriptionsResponse> {
  if (USE_MOCK) {
    const seen = new Set<string>();
    const subscriptions = MOCK_USER_APPLICATIONS
      .filter((ua) => ua.isActive && !seen.has(ua.applicationId) && (seen.add(ua.applicationId), true))
      .map((ua) => {
        const app = MOCK_APPLICATIONS.find((a) => a.id === ua.applicationId);
        const plans = MOCK_PLANS.filter((p) => p.applicationId === ua.applicationId);
        const current = plans.find((p) => p.id === ua.subscriptionPlanId) ?? null;
        return {
          applicationId: ua.applicationId,
          applicationName: app?.name ?? 'Application',
          applicationSlug: app?.slug ?? '',
          applicationIcon: app?.icon ?? null,
          isActive: true,
          plan: current,
          availablePlans: plans,
        };
      });
    return { subscriptions, stripeConfigured: MOCK_SERVICES_CONFIG.stripe };
  }
  return apiFetch<UserSubscriptionsResponse>('/user/subscription');
}

/**
 * Self-service plan change. The server refuses unless Stripe is configured —
 * without a payment provider only administrators change a plan.
 */
export async function changeMyPlan(
  applicationId: string,
  planId: string,
): Promise<{ ok: true; changed: boolean }> {
  if (USE_MOCK) {
    const ua = MOCK_USER_APPLICATIONS.find((u) => u.applicationId === applicationId);
    if (ua) {
      ua.subscriptionPlanId = planId;
      ua.subscriptionPlanName = MOCK_PLANS.find((p) => p.id === planId)?.name ?? null;
    }
    return { ok: true, changed: true };
  }
  return apiFetch<{ ok: true; changed: boolean }>(
    `/user/subscription/${applicationId}`,
    { method: 'PATCH', body: JSON.stringify({ planId }) },
  );
}
