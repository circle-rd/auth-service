import { apiFetch, USE_MOCK } from './client';
import type { ChangePlanResult, UserSubscriptionsResponse } from '@/types';
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
 * without a payment provider only administrators change a plan. A free plan
 * applies at once; a paid one either changes the live Stripe subscription
 * (`pending`) or returns the Stripe Checkout to open (`checkoutUrl`).
 */
export async function changeMyPlan(
  applicationId: string,
  planId: string,
): Promise<ChangePlanResult> {
  if (USE_MOCK) {
    const ua = MOCK_USER_APPLICATIONS.find((u) => u.applicationId === applicationId);
    if (ua) {
      ua.subscriptionPlanId = planId;
      ua.subscriptionPlanName = MOCK_PLANS.find((p) => p.id === planId)?.name ?? null;
    }
    return { ok: true, changed: true, pending: false, checkoutUrl: null };
  }
  return apiFetch<ChangePlanResult>(
    `/user/subscription/${applicationId}`,
    { method: 'PATCH', body: JSON.stringify({ planId }) },
  );
}

/** Administrator: stop (or resume) a user's Stripe subscription at period end. */
export async function setSubscriptionCancellation(
  applicationId: string,
  userId: string,
  cancel: boolean,
): Promise<{ ok: true; cancelAtPeriodEnd: boolean }> {
  if (USE_MOCK) return { ok: true, cancelAtPeriodEnd: cancel };
  const action = cancel ? 'cancel' : 'resume';
  return apiFetch<{ ok: true; cancelAtPeriodEnd: boolean }>(
    `/admin/applications/${applicationId}/users/${encodeURIComponent(userId)}/subscription/${action}`,
    { method: 'POST' },
  );
}
