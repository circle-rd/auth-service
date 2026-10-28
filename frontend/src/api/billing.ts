import { apiFetch, USE_MOCK } from './client';
import type { BillingInvoicePage, BillingUsage } from '@/types';
import { MOCK_INVOICE_PAGE, MOCK_USAGE } from '@/mocks/billing';

/** The caller's invoices across applications, newest first, one page at a time. */
export async function getMyInvoices(
  params: { cursor?: string; limit?: number } = {},
): Promise<BillingInvoicePage> {
  if (USE_MOCK) return MOCK_INVOICE_PAGE;
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return apiFetch<BillingInvoicePage>(`/user/billing/invoices${qs ? `?${qs}` : ''}`);
}

/** Metered usage of the current period in one application the caller uses. */
export async function getMyUsage(applicationId: string): Promise<BillingUsage> {
  if (USE_MOCK) return MOCK_USAGE;
  return apiFetch<BillingUsage>(`/user/billing/usage?applicationId=${encodeURIComponent(applicationId)}`);
}
