<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Bar } from 'vue-chartjs';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';
import { withAlpha } from '@/utils/chartPalette';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const props = defineProps<{
  series: { date: string; allow: number; deny?: number }[];
  allowLabel: string;
  denyLabel?: string;
  loading?: boolean;
}>();

const { locale } = useI18n();

const ALLOW = '#10b981';
const DENY = '#f43f5e';

function integerTick(value: string | number): string {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) ? String(n) : '';
}

const data = computed(() => ({
  labels: props.series.map((point) =>
    new Date(`${point.date}T00:00:00Z`).toLocaleDateString(locale.value, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  ),
  datasets: [
    {
      label: props.allowLabel,
      data: props.series.map((point) => point.allow),
      backgroundColor: withAlpha(ALLOW, 0.65),
      hoverBackgroundColor: ALLOW,
      borderRadius: 3,
      maxBarThickness: 18,
    },
    ...(props.denyLabel
      ? [{
          label: props.denyLabel,
          data: props.series.map((point) => point.deny ?? 0),
          backgroundColor: withAlpha(DENY, 0.65),
          hoverBackgroundColor: DENY,
          borderRadius: 3,
          maxBarThickness: 18,
        }]
      : []),
  ],
}));

const options = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index' as const, intersect: false },
  plugins: {
    legend: {
      display: props.denyLabel !== undefined,
      position: 'top' as const,
      labels: { color: '#94a3b8', boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11 } },
    },
  },
  scales: {
    x: { stacked: true, grid: { display: false }, ticks: { color: '#64748b', font: { size: 11 }, maxTicksLimit: 8 } },
    y: {
      stacked: true,
      beginAtZero: true,
      grid: { color: 'rgba(148,163,184,0.08)' },
      ticks: { color: '#64748b', font: { size: 11 }, maxTicksLimit: 6, callback: integerTick },
    },
  },
}));

const hasData = computed(() => props.series.some((point) => point.allow > 0 || (point.deny ?? 0) > 0));
</script>

<template>
  <div class="h-56" data-testid="decision-chart">
    <div v-if="loading" class="h-full bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-xl" />
    <Bar v-else-if="hasData" :data="data" :options="options" />
    <div v-else class="h-full flex items-center justify-center text-sm text-surface-500">
      <slot name="empty" />
    </div>
  </div>
</template>
