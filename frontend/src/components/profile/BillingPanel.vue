<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Receipt, Gauge } from 'lucide-vue-next';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import { getMyInvoices, getMyUsage } from '@/api/billing';
import { useToast } from '@/composables/useToast';
import type { BillingInvoice, BillingUsage, UserSubscriptionEntry } from '@/types';

const props = defineProps<{
  subscriptions: UserSubscriptionEntry[];
  loading: boolean;
}>();

const { t, locale } = useI18n();
const toast = useToast();

// ── Usage of the current period, per application with a plan ─────────────────

const usage = ref<Record<string, BillingUsage | null>>({});

const withPlan = computed(() => props.subscriptions.filter((s) => s.plan));

async function loadUsage(): Promise<void> {
  for (const sub of withPlan.value) {
    if (sub.applicationId in usage.value) continue;
    try {
      usage.value[sub.applicationId] = await getMyUsage(sub.applicationId);
    } catch {
      usage.value[sub.applicationId] = null;
    }
  }
}

watch(withPlan, () => void loadUsage());

function share(used: number, limit: number): number {
  return Math.min(100, Math.round((used / limit) * 100));
}

// ── Invoices, newest first, one page at a time ───────────────────────────────

const invoices = ref<BillingInvoice[]>([]);
const nextCursor = ref<string | null>(null);
const invoicesLoading = ref(false);
const invoicesLoaded = ref(false);

async function loadInvoices(more = false): Promise<void> {
  if (invoicesLoading.value) return;
  invoicesLoading.value = true;
  try {
    const page = await getMyInvoices({ cursor: more ? nextCursor.value ?? undefined : undefined });
    invoices.value = more ? [...invoices.value, ...page.items] : page.items;
    nextCursor.value = page.nextCursor;
    invoicesLoaded.value = true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('common.error'));
  } finally {
    invoicesLoading.value = false;
  }
}

onMounted(() => {
  void loadUsage();
  void loadInvoices();
});

// ── Formatting ───────────────────────────────────────────────────────────────

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat(locale.value, { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100);
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
  <div class="space-y-5" data-testid="billing-panel">
    <!-- Usage this month -->
    <section v-if="withPlan.length" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
      <header class="px-5 py-4 border-b border-surface-700/40 flex items-center gap-2">
        <Gauge class="w-4 h-4 text-surface-400" />
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.billingPanel.usageTitle') }}</h3>
      </header>
      <div class="divide-y divide-surface-800/40">
        <div v-for="sub in withPlan" :key="sub.applicationId" class="px-5 py-4">
          <div class="flex items-center gap-3 mb-3">
            <img v-if="sub.applicationIcon" :src="sub.applicationIcon" class="w-5 h-5 rounded shrink-0" />
            <p class="text-sm font-medium text-surface-200 flex-1 truncate">{{ sub.applicationName }}</p>
            <BaseBadge variant="neutral" size="sm">{{ sub.plan!.name }}</BaseBadge>
          </div>
          <p v-if="usage[sub.applicationId] === null" class="text-xs text-surface-500">{{ t('profile.billingPanel.usageUnavailable') }}</p>
          <p v-else-if="usage[sub.applicationId] && usage[sub.applicationId]!.features.length === 0" class="text-xs text-surface-500">
            {{ t('profile.billingPanel.noMetered') }}
          </p>
          <ul v-else-if="usage[sub.applicationId]" class="space-y-3">
            <li v-for="f in usage[sub.applicationId]!.features" :key="f.featureKey">
              <div class="flex items-baseline justify-between text-sm">
                <code class="text-xs font-mono text-surface-500">{{ f.featureKey }}</code>
                <span class="tabular-nums text-surface-200">
                  {{ f.used.toLocaleString(locale) }}
                  <template v-if="f.usageLimit >= 0"> / {{ f.usageLimit.toLocaleString(locale) }}</template>
                  <span class="text-surface-500"> {{ f.unit ?? '' }}</span>
                </span>
              </div>
              <div v-if="f.usageLimit > 0" class="mt-1.5 h-1.5 rounded-full bg-surface-800 overflow-hidden" role="progressbar" :aria-valuenow="share(f.used, f.usageLimit)" aria-valuemin="0" aria-valuemax="100">
                <div class="h-full rounded-full bg-primary-500" :style="{ width: `${share(f.used, f.usageLimit)}%` }" />
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- Invoice history -->
    <section class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
      <header class="px-5 py-4 border-b border-surface-700/40 flex items-center gap-2">
        <Receipt class="w-4 h-4 text-surface-400" />
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.billingPanel.invoicesTitle') }}</h3>
      </header>

      <div v-if="!invoicesLoaded && invoicesLoading" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.loading') }}</div>
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
  </div>
</template>
