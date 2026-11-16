<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { TrendingUp } from '@lucide/vue';
import type { AppSubscriptionRow } from '@/api/applications';
import type { ConsumptionAggregate, SubscriptionPlan } from '@/types';

const props = defineProps<{
  subscriptions: AppSubscriptionRow[];
  plans: SubscriptionPlan[];
  consumption: ConsumptionAggregate[];
}>();

const { t } = useI18n();

const financialKpis = computed(() => {
  const subscribedUsers = props.subscriptions;
  const activeSubscriptions = subscribedUsers.filter((s) => s.isActive);
  const activeSubscribers = activeSubscriptions.length;

  let mrr = 0;
  const planRevenue: Record<string, { name: string; subscribers: number; monthly: number; currency: string }> = {};

  for (const subscription of activeSubscriptions) {
    const plan = props.plans.find((p) => p.id === subscription.planId);
    if (!plan) continue;
    const price = plan.prices.find((p) => p.billingType === 'fixed' && p.interval === 'month');
    const amount = price ? Number(price.amount) : 0;
    const currency = price?.currency ?? 'eur';
    mrr += amount;

    if (!planRevenue[plan.id]) planRevenue[plan.id] = { name: plan.name, subscribers: 0, monthly: 0, currency };
    planRevenue[plan.id].subscribers += 1;
    planRevenue[plan.id].monthly += amount;
  }

  const meteredKeys = new Map<string, { unit: string; totalUsage: number; pricePerUnit: number; revenue: number; currency: string }>();
  for (const plan of props.plans) {
    for (const price of plan.prices) {
      const key = price.featureKey;
      if (price.billingType !== 'metered' || !key) continue;
      const unitPrice = Number(price.amount);
      if (!meteredKeys.has(key)) meteredKeys.set(key, { unit: price.unit ?? '', totalUsage: 0, pricePerUnit: unitPrice, revenue: 0, currency: price.currency });
      for (const subscription of subscribedUsers.filter((s) => s.planId === plan.id)) {
        const agg = props.consumption.find((c) => c.userId === subscription.userId && c.key === key);
        if (!agg) continue;
        const entry = meteredKeys.get(key)!;
        entry.totalUsage += Number(agg.total);
        entry.revenue += Number(agg.total) * unitPrice;
      }
    }
  }

  return {
    activeSubscribers,
    mrr,
    arr: mrr * 12,
    currency: Object.values(planRevenue)[0]?.currency ?? 'eur',
    byPlan: Object.values(planRevenue),
    meteredUsage: [...meteredKeys.entries()].map(([key, v]) => ({ key, ...v })),
  };
});

function formatPrice(amount: string, currency: string) {
  return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 0 }).format(Number(amount) / 100);
}
</script>

<template>
  <div class="space-y-5">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-4 sm:p-5">
        <p class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">{{ t('appDetail.activeSubscribers') }}</p>
        <p class="text-2xl font-bold text-surface-100">{{ financialKpis.activeSubscribers }}</p>
      </div>
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-4 sm:p-5">
        <p class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">{{ t('appDetail.mrr') }}</p>
        <p class="text-2xl font-bold text-surface-100">{{ formatPrice(String(financialKpis.mrr), financialKpis.currency) }}</p>
      </div>
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-4 sm:p-5">
        <p class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">{{ t('appDetail.arr') }}</p>
        <p class="text-2xl font-bold text-surface-100">{{ formatPrice(String(financialKpis.arr), financialKpis.currency) }}</p>
      </div>
    </div>

    <div v-if="!financialKpis.activeSubscribers && !plans.length" class="text-center text-sm text-surface-500 py-8">{{ t('appDetail.noFinancialData') }}</div>
    <template v-else>
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <div class="px-5 py-3 border-b border-surface-700/40 flex items-center gap-2">
          <TrendingUp class="w-4 h-4 text-surface-400" />
          <h3 class="text-sm font-semibold text-surface-300">{{ t('appDetail.revenueByPlan') }}</h3>
        </div>
        <div v-if="!financialKpis.byPlan.length" class="px-5 py-5 text-sm text-surface-500 text-center">{{ t('appDetail.noFinancialData') }}</div>
        <div v-else class="divide-y divide-surface-800/40">
          <div v-for="row in financialKpis.byPlan" :key="row.name" class="px-5 py-3 flex items-center gap-4">
            <span class="flex-1 text-sm font-medium text-surface-200">{{ row.name }}</span>
            <span class="text-xs text-surface-500">{{ row.subscribers }} {{ t('appDetail.subscribers') }}</span>
            <span class="text-sm font-semibold text-surface-100 tabular-nums">{{ formatPrice(String(row.monthly), row.currency) }}{{ t('appDetail.perMonthShort') }}</span>
          </div>
        </div>
      </div>

      <div v-if="financialKpis.meteredUsage.length" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <div class="px-5 py-3 border-b border-surface-700/40">
          <h3 class="text-sm font-semibold text-surface-300">{{ t('appDetail.meteredUsage') }}</h3>
        </div>
        <div class="divide-y divide-surface-800/40">
          <div v-for="row in financialKpis.meteredUsage" :key="row.key" class="px-5 py-3 flex items-center gap-4">
            <code class="text-xs font-mono text-surface-400 bg-surface-800/50 px-2 py-0.5 rounded w-36 shrink-0">{{ row.key }}</code>
            <span class="text-sm text-surface-300 flex-1">{{ row.totalUsage.toLocaleString() }} {{ row.unit }}</span>
            <span class="text-xs text-surface-500">{{ formatPrice(String(row.pricePerUnit), row.currency) }}/{{ row.unit }}</span>
            <span class="text-sm font-semibold text-surface-100 tabular-nums">{{ formatPrice(String(row.revenue), row.currency) }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
