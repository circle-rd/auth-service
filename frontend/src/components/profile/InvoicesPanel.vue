<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Receipt } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import { getMyInvoices } from '@/api/billing';
import { useToast } from '@/composables/useToast';
import type { BillingInvoice } from '@/types';

const { t, locale } = useI18n();
const toast = useToast();

const invoices = ref<BillingInvoice[]>([]);
const nextCursor = ref<string | null>(null);
const invoicesLoading = ref(false);
const invoicesLoaded = ref(false);
const loadError = ref(false);

async function loadInvoices(more = false): Promise<void> {
  if (invoicesLoading.value) return;
  invoicesLoading.value = true;
  loadError.value = false;
  try {
    const page = await getMyInvoices({ cursor: more ? nextCursor.value ?? undefined : undefined });
    invoices.value = more ? [...invoices.value, ...page.items] : page.items;
    nextCursor.value = page.nextCursor;
    invoicesLoaded.value = true;
  } catch (err) {
    loadError.value = true;
    toast.error(err instanceof Error ? err.message : t('common.error'));
  } finally {
    invoicesLoading.value = false;
  }
}

onMounted(() => void loadInvoices());

// Stripe amounts are minor units; most currencies have two decimals, but some
// have none or three and must not be divided by 100.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);
const THREE_DECIMAL_CURRENCIES = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

function money(minor: number, currency: string): string {
  const code = currency.toLowerCase();
  const exponent = ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : THREE_DECIMAL_CURRENCIES.has(code) ? 3 : 2;
  return new Intl.NumberFormat(locale.value, { style: 'currency', currency: currency.toUpperCase() }).format(minor / 10 ** exponent);
}

function day(iso: string): string {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(iso));
}

function kindOf(invoice: BillingInvoice): string {
  return invoice.billingReason?.startsWith('subscription')
    ? t('profile.billingPanel.kinds.subscription')
    : t('profile.billingPanel.kinds.topup');
}

function statusVariant(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'paid') return 'success';
  if (status === 'open' || status === 'draft') return 'warning';
  return 'neutral';
}

/** Only an https link from the server is shown as a link. */
function safeLink(url: string | null): string | null {
  return url && url.startsWith('https://') ? url : null;
}
</script>

<template>
  <section class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
    <header class="px-5 py-4 border-b border-surface-700/40 flex items-center gap-2">
      <Receipt class="w-4 h-4 text-surface-400" />
      <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.billingPanel.invoicesTitle') }}</h3>
    </header>

    <div v-if="!invoicesLoaded && invoicesLoading" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.loading') }}</div>
    <div v-else-if="loadError && invoices.length === 0" class="px-5 py-8 text-center text-sm text-surface-500">
      <p>{{ t('profile.billingPanel.invoicesError') }}</p>
      <BaseButton class="mt-3" variant="outline" size="sm" @click="loadInvoices()">{{ t('common.retry') }}</BaseButton>
    </div>
    <div v-else-if="invoicesLoaded && invoices.length === 0" class="px-5 py-8 text-center text-sm text-surface-500">
      {{ t('profile.billingPanel.noInvoices') }}
    </div>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-surface-500 uppercase tracking-wider">
            <th class="px-5 py-2 font-medium">{{ t('profile.billingPanel.date') }}</th>
            <th class="px-3 py-2 font-medium">{{ t('profile.billingPanel.kind') }}</th>
            <th class="px-3 py-2 font-medium">{{ t('profile.billingPanel.status') }}</th>
            <th class="px-3 py-2 font-medium text-right">{{ t('profile.billingPanel.amount') }}</th>
            <th class="px-5 py-2 font-medium text-right"><span class="sr-only">{{ t('profile.billingPanel.documents') }}</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-surface-800/40">
          <tr v-for="inv in invoices" :key="inv.id">
            <td class="px-5 py-3 text-surface-200">{{ day(inv.createdAt) }}</td>
            <td class="px-3 py-3 text-surface-400">{{ kindOf(inv) }}</td>
            <td class="px-3 py-3">
              <BaseBadge :variant="statusVariant(inv.status)" size="sm">{{ t(`profile.billingPanel.statuses.${inv.status}`, inv.status) }}</BaseBadge>
            </td>
            <td class="px-3 py-3 text-right tabular-nums text-surface-100">{{ money(inv.amountPaid || inv.amountDue, inv.currency) }}</td>
            <td class="px-5 py-3 text-right whitespace-nowrap">
              <a v-if="safeLink(inv.hostedInvoiceUrl)" :href="safeLink(inv.hostedInvoiceUrl)!" target="_blank" rel="noopener" class="text-primary-400 hover:underline">{{ t('profile.billingPanel.view') }}</a>
              <a v-if="safeLink(inv.invoicePdf)" :href="safeLink(inv.invoicePdf)!" target="_blank" rel="noopener" class="ml-3 text-primary-400 hover:underline">{{ t('profile.billingPanel.pdf') }}</a>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="nextCursor" class="px-5 py-4 border-t border-surface-700/40 text-center">
      <BaseButton variant="outline" size="sm" :loading="invoicesLoading" @click="loadInvoices(true)">
        {{ t('profile.billingPanel.olderInvoices') }}
      </BaseButton>
    </div>
  </section>
</template>
