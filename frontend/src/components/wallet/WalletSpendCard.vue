<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronDown, ChevronUp } from '@lucide/vue';
import SpendChart from '@/components/wallet/SpendChart.vue';
import type { SpendChartSeries } from '@/components/wallet/SpendChart.vue';
import SpendBreakdown from '@/components/wallet/SpendBreakdown.vue';
import { useMoney } from '@/composables/useMoney';
import { modelColor } from '@/utils/chartPalette';
import type { UserSpendStats } from '@/types/wallet';

const props = defineProps<{
  stats: UserSpendStats | null;
  loading?: boolean;
}>();

// The chart is stacked by model; beyond the top few, the tail would crowd the
// legend, so only the biggest series are drawn (the day detail shows the rest).
const MAX_MODEL_SERIES = 6;

const { t, locale } = useI18n();
const { fmt } = useMoney();

const modelLabel = (model: string): string =>
  model === 'mcp' || model === 'other' ? t(`wallet.spend.models.${model}`) : model;

const labels = computed(() =>
  (props.stats?.daily ?? []).map((d) =>
    new Date(`${d.date}T00:00:00Z`).toLocaleDateString(locale.value, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  ),
);

const datasets = computed<SpendChartSeries[]>(() => {
  const daily = props.stats?.daily ?? [];
  const totals = new Map<string, bigint>();
  for (const day of daily) {
    for (const m of day.byModel) {
      totals.set(m.model, (totals.get(m.model) ?? 0n) + BigInt(m.amount));
    }
  }
  return [...totals.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, MAX_MODEL_SERIES)
    .map(([model]) => ({
      label: modelLabel(model),
      color: modelColor(model),
      values: daily.map((d) => Number(d.byModel.find((m) => m.model === model)?.amount ?? '0')),
    }));
});

const useStacks = computed(() => datasets.value.length > 0);
const detailsOpen = ref(false);
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
        <p v-if="BigInt(stats.notBilled) > 0n" class="text-xs text-primary-400" data-testid="wallet-spend-not-billed">
          {{ t('wallet.spend.notBilled', { amount: fmt(stats.notBilled) }) }}
        </p>
      </div>
    </div>

    <SpendChart
      v-if="useStacks"
      :labels="labels"
      :datasets="datasets"
      :loading="loading || !stats"
    >
      <template #empty>{{ t('wallet.spend.none') }}</template>
    </SpendChart>
    <SpendChart v-else :series="stats?.series ?? []" :loading="loading || !stats">
      <template #empty>{{ t('wallet.spend.none') }}</template>
    </SpendChart>

    <div v-if="stats && stats.calls > 0" class="mt-6 pt-6 border-t border-surface-700/40">
      <button
        type="button"
        class="inline-flex items-center gap-1.5 text-xs font-medium text-surface-400 hover:text-surface-200 transition-colors"
        :aria-expanded="detailsOpen"
        @click="detailsOpen = !detailsOpen"
      >
        <component :is="detailsOpen ? ChevronUp : ChevronDown" class="w-3.5 h-3.5" />
        {{ t('wallet.spend.details') }}
      </button>
      <SpendBreakdown
        v-if="detailsOpen"
        class="mt-4"
        :by-application="stats.byApplication"
        :by-kind="stats.byKind"
        :by-model="stats.byModel"
      />
    </div>
  </div>
</template>
