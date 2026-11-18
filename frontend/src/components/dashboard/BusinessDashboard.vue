<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Bar } from 'vue-chartjs';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip } from 'chart.js';
import { CircleDollarSign, Receipt, Repeat, TrendingUp, TriangleAlert } from '@lucide/vue';
import StatCard from '@/components/ui/StatCard.vue';
import DashboardWalletSection from '@/components/wallet/DashboardWalletSection.vue';
import { useAdminEvents } from '@/composables/useAdminEvents';
import { getBillingStats, type BillingStats } from '@/api/stats';
import { getBusinessStats, type BusinessStats, type MonitoringRange } from '@/api/monitoring';
import { formatMinorAmount } from '@/utils/money';
import { withAlpha } from '@/utils/chartPalette';
import RankList, { type RankItem } from './RankList.vue';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

const { t, locale } = useI18n();

const range = ref<MonitoringRange>('30d');
const business = ref<BusinessStats | null>(null);
const billing = ref<BillingStats | null>(null);
const failed = ref(false);
const walletSection = ref<InstanceType<typeof DashboardWalletSection> | null>(null);

const events = useAdminEvents({
  'wallet.changed': () => void walletSection.value?.refresh(),
  'subscription.changed': () => void load(),
});

function money(minor: number, currency: string): string {
  return formatMinorAmount(minor, currency, { locale: locale.value });
}

async function load() {
  const [biz, bill] = await Promise.allSettled([getBusinessStats(), getBillingStats({ range: range.value })]);
  if (biz.status === 'fulfilled') business.value = biz.value;
  if (bill.status === 'fulfilled') billing.value = bill.value;
  failed.value = biz.status === 'rejected' && bill.status === 'rejected';
}

watch(range, () => void load());
onMounted(() => void load());
onUnmounted(() => events.close());

const planItems = computed<RankItem[]>(() =>
  (business.value?.byPlan ?? []).map((plan) => ({
    key: plan.planId,
    label: plan.planName,
    sub: plan.applicationName,
    value: plan.count,
    note: money(plan.mrr, business.value?.currency ?? 'eur'),
  })),
);

const chartData = computed(() => {
  const series = billing.value?.revenue.series ?? [];
  const color = '#10b981';
  return {
    labels: series.map((point) =>
      new Date(`${point.date}T00:00:00Z`).toLocaleDateString(locale.value, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    ),
    datasets: [{
      data: series.map((point) => point.amount),
      backgroundColor: withAlpha(color, 0.6),
      hoverBackgroundColor: color,
      borderRadius: 3,
      maxBarThickness: 18,
    }],
  };
});

const chartOptions = computed(() => {
  const currency = billing.value?.currency ?? 'eur';
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (ctx: { parsed: { y: number | null } }) => money(ctx.parsed.y ?? 0, currency) } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 11 }, maxTicksLimit: 8 } },
      y: {
        beginAtZero: true,
        grid: { color: 'rgba(148,163,184,0.08)' },
        ticks: { color: '#64748b', font: { size: 11 }, maxTicksLimit: 6, callback: (value: string | number) => money(Number(value), currency) },
      },
    },
  };
});

const hasRevenue = computed(() => (billing.value?.revenue.series ?? []).some((point) => point.amount > 0));
</script>

<template>
  <div class="space-y-6" data-testid="business-dashboard">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <p class="text-sm text-surface-400">{{ t('dashboard.business.hint') }}</p>
      <div class="flex gap-1">
        <button
          v-for="value in (['7d', '30d'] as const)"
          :key="value"
          type="button"
          :class="['px-2.5 py-1 rounded-lg text-xs font-medium transition-colors', range === value ? 'bg-primary-600/20 text-primary-300' : 'text-surface-500 hover:text-surface-300']"
          @click="range = value"
        >
          {{ t(`dashboard.timeRanges.${value}`) }}
        </button>
      </div>
    </div>

    <div v-if="failed" class="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/8 border border-amber-500/20 text-amber-300">
      <TriangleAlert class="w-4 h-4 mt-0.5 shrink-0" />
      <p class="text-sm">{{ t('dashboard.business.unavailable') }}</p>
    </div>

    <template v-else>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <StatCard
          :label="t('dashboard.business.mrr')"
          :value="business ? money(business.mrr, business.currency) : ''"
          :loading="!business"
          :icon="Repeat"
          :sub="t('dashboard.business.mrrNote')"
        />
        <StatCard
          :label="t('dashboard.business.arr')"
          :value="business ? money(business.arr, business.currency) : ''"
          :loading="!business"
          :icon="TrendingUp"
        />
        <StatCard
          :label="t('dashboard.business.paying')"
          :value="business ? business.payingSubscriptions : ''"
          :loading="!business"
          :icon="CircleDollarSign"
          :sub="business && business.unpricedSubscriptions > 0 ? t('dashboard.business.unpriced', { count: business.unpricedSubscriptions }) : ''"
        />
        <StatCard
          :label="t('dashboard.business.revenue')"
          :value="billing ? money(billing.revenue.total, billing.currency) : ''"
          :loading="!billing"
          :icon="Receipt"
          :sub="billing ? t('dashboard.business.invoices', { count: billing.revenue.count }) : ''"
        />
        <StatCard
          :label="t('dashboard.business.atRisk')"
          :value="billing ? billing.subscriptions.cancelAtPeriodEnd : ''"
          :loading="!billing"
          :icon="TriangleAlert"
          :sub="billing ? t('dashboard.business.openInvoices', { amount: money(billing.invoices.openAmount, billing.currency), count: billing.invoices.openCount }) : ''"
        />
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section class="lg:col-span-2 rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
          <h3 class="text-sm font-semibold text-surface-200 mb-4">{{ t('dashboard.business.revenueChart') }}</h3>
          <div class="h-56">
            <Bar v-if="hasRevenue" :data="chartData" :options="chartOptions" />
            <div v-else class="h-full flex items-center justify-center text-sm text-surface-500">
              {{ t('dashboard.business.noRevenue') }}
            </div>
          </div>
        </section>
        <RankList
          :title="t('dashboard.business.byPlan')"
          :items="planItems"
          :empty="t('dashboard.business.noSubscriptions')"
          bar-class="bg-emerald-500/60"
        />
      </div>
    </template>

    <DashboardWalletSection ref="walletSection" />
  </div>
</template>
