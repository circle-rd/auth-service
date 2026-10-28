import type { BillingInvoicePage, BillingUsage } from '@/types';

export const MOCK_INVOICE_PAGE: BillingInvoicePage = {
  items: [
    {
      id: 'in_mock_2',
      status: 'paid',
      billingReason: 'subscription_cycle',
      currency: 'eur',
      amountDue: 1500,
      amountPaid: 1500,
      amountRemaining: 0,
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/mock',
      invoicePdf: null,
    },
    {
      id: 'in_mock_1',
      status: 'paid',
      billingReason: 'manual',
      currency: 'eur',
      amountDue: 1000,
      amountPaid: 1000,
      amountRemaining: 0,
      periodStart: null,
      periodEnd: null,
      createdAt: '2026-09-15T00:00:00.000Z',
      hostedInvoiceUrl: null,
      invoicePdf: null,
    },
  ],
  nextCursor: null,
};

export const MOCK_USAGE: BillingUsage = {
  periodStart: '2026-10-01T00:00:00.000Z',
  features: [
    { featureKey: 'api.calls', unit: 'call', usageLimit: 1000, used: 340, remaining: 660 },
    { featureKey: 'exports', unit: 'file', usageLimit: -1, used: 12, remaining: null },
  ],
};
