<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Coins, TrendingDown, Wallet } from 'lucide-vue-next';
import StatCard from '@/components/ui/StatCard.vue';
import SpendChart from '@/components/wallet/SpendChart.vue';
import { getWalletStats } from '@/api/wallet';
import { useMoney } from '@/composables/useMoney';
import type { AdminWalletStats } from '@/types/wallet';

const DAYS = 30;
const POLL_MS = 30_000;

const { t } = useI18n();
const { fmt } = useMoney();

const stats = ref<AdminWalletStats | null>(null);
const failed = ref(false);

async function refresh(): Promise<void> {
  try {
    stats.value = await getWalletStats(DAYS);
    failed.value = false;
  } catch {
    failed.value = true;
  }
}

// The dashboard owns the single admin event subscription and calls this on `wallet.changed`.
defineExpose({ refresh });

let poll: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void refresh();
  poll = setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS);
});
onUnmounted(() => {
  if (poll) clearInterval(poll);
});
</script>

<template>
  <section v-if="!failed" class="space-y-4" data-testid="dashboard-wallet">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold text-surface-200">{{ t('wallet.dashboard.section') }}</h3>
      <RouterLink to="/wallets" class="text-xs text-primary-400 hover:text-primary-300">{{ t('wallet.dashboard.viewAll') }}</RouterLink>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <StatCard :label="t('wallet.dashboard.credit')" :value="stats ? fmt(stats.totals.outstandingCredit) : ''" :loading="!stats" :icon="Wallet" />
      <StatCard
        :label="t('wallet.dashboard.debt')"
        :value="stats ? fmt(stats.totals.outstandingDebt) : ''"
        :sub="stats ? t('wallet.admin.debtSub', { count: stats.totals.accountsInDebt }) : ''"
        :loading="!stats"
        :icon="TrendingDown"
      />
      <StatCard
        :label="t('wallet.dashboard.spend', { days: DAYS })"
        :value="stats ? fmt(stats.spend.total) : ''"
        :sub="stats ? t('wallet.spend.calls', { count: stats.spend.calls }) : ''"
        :loading="!stats"
        :icon="Coins"
      />
    </div>
    <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
      <p class="text-sm font-semibold text-surface-200 mb-4">{{ t('wallet.dashboard.chart') }}</p>
      <SpendChart :series="stats?.spend.series ?? []" :loading="!stats">
        <template #empty>{{ t('wallet.spend.none') }}</template>
      </SpendChart>
    </div>
  </section>
</template>
