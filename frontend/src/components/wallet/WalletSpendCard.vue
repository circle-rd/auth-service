<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import SpendChart from '@/components/wallet/SpendChart.vue';
import SpendBreakdown from '@/components/wallet/SpendBreakdown.vue';
import { useMoney } from '@/composables/useMoney';
import type { UserSpendStats } from '@/types/wallet';

defineProps<{
  stats: UserSpendStats | null;
  loading?: boolean;
}>();

const { t } = useI18n();
const { fmt } = useMoney();
</script>

<template>
  <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-6" data-testid="wallet-spend">
    <div class="flex items-start justify-between gap-4 mb-4">
      <div>
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('wallet.spend.title') }}</h3>
        <p v-if="stats" class="text-xs text-surface-600 mt-0.5">{{ t('wallet.spend.lastDays', { days: stats.days }) }}</p>
      </div>
      <div v-if="stats" class="text-right">
        <p class="text-xl font-semibold tabular-nums text-surface-50">{{ fmt(stats.total) }}</p>
        <p class="text-xs text-surface-500">{{ t('wallet.spend.calls', { count: stats.calls }) }}</p>
      </div>
    </div>

    <SpendChart :series="stats?.series ?? []" :loading="loading || !stats">
      <template #empty>{{ t('wallet.spend.none') }}</template>
    </SpendChart>

    <div v-if="stats && stats.calls > 0" class="mt-6 pt-6 border-t border-surface-700/40">
      <SpendBreakdown :by-application="stats.byApplication" :by-kind="stats.byKind" />
    </div>
  </div>
</template>
