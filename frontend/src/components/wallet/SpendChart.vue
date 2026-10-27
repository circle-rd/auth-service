<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Bar } from 'vue-chartjs';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';
import { useMoney } from '@/composables/useMoney';
import { withAlpha } from '@/utils/chartPalette';
import type { WalletDailyPoint } from '@/types/wallet';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

export interface SpendChartSeries {
  label: string;
  color: string;
  /** One value per label, in micro-euros. */
  values: number[];
}

const props = defineProps<{
  /** Single-series mode: one bar per day, total spend. */
  series?: WalletDailyPoint[];
  /** Multi-series mode: each series stacks by label (e.g. by model). */
  datasets?: SpendChartSeries[];
  labels?: string[];
  color?: string;
  stacked?: boolean;
  loading?: boolean;
}>();

const { locale } = useI18n();
const { fmt } = useMoney();

const color = computed(() => props.color ?? '#3b82f6');

const labels = computed(() =>
  props.labels ??
  (props.series ?? []).map((p) =>
    new Date(`${p.date}T00:00:00Z`).toLocaleDateString(locale.value, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  ),
);

const toEuros = (micro: number): number => micro / 1_000_000;

const chartDatasets = computed(() => {
  if (props.datasets && props.datasets.length > 0) {
    return props.datasets.map((ds) => ({
      label: ds.label,
      data: ds.values.map(toEuros),
      backgroundColor: withAlpha(ds.color, 0.6),
      hoverBackgroundColor: ds.color,
      borderRadius: 3,
      maxBarThickness: 18,
    }));
  }
  return [{
    data: (props.series ?? []).map((p) => toEuros(Number(p.amount))),
    backgroundColor: withAlpha(color.value, 0.6),
    hoverBackgroundColor: color.value,
    borderRadius: 3,
    maxBarThickness: 18,
  }];
});

const data = computed(() => ({ labels: labels.value, datasets: chartDatasets.value }));

const stacked = computed(() => props.stacked ?? (props.datasets?.length ?? 0) > 0);
const showLegend = computed(() => (props.datasets?.length ?? 0) > 1);

const options = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: showLegend.value, labels: { color: '#94a3b8', boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
    tooltip: {
      callbacks: {
        label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) =>
          `${ctx.dataset.label ? `${ctx.dataset.label}: ` : ''}${fmt(BigInt(Math.round((ctx.parsed.y ?? 0) * 1_000_000)))}`,
      },
    },
  },
  scales: {
    x: { stacked: stacked.value, grid: { display: false }, ticks: { color: '#64748b', font: { size: 11 }, maxTicksLimit: 8 } },
    y: {
      stacked: stacked.value,
      beginAtZero: true,
      grid: { color: 'rgba(148,163,184,0.08)' },
      ticks: { color: '#64748b', font: { size: 11 }, callback: (v: string | number) => fmt(BigInt(Math.round(Number(v) * 1_000_000))) },
    },
  },
}));

const hasData = computed(() =>
  chartDatasets.value.some((ds) => ds.data.some((v) => v > 0)),
);
</script>

<template>
  <div class="h-56" data-testid="spend-chart">
    <div v-if="loading" class="h-full bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-xl" />
    <Bar v-else-if="hasData" :data="data" :options="options" />
    <div v-else class="h-full flex items-center justify-center text-sm text-surface-500">
      <slot name="empty" />
    </div>
  </div>
</template>
