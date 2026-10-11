<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Bar } from 'vue-chartjs';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip } from 'chart.js';
import { useMoney } from '@/composables/useMoney';
import type { WalletDailyPoint } from '@/types/wallet';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

const props = defineProps<{
  series: WalletDailyPoint[];
  color?: string;
  loading?: boolean;
}>();

const { locale } = useI18n();
const { fmt } = useMoney();

const color = computed(() => props.color ?? '#3b82f6');

const data = computed(() => ({
  labels: props.series.map((p) =>
    new Date(`${p.date}T00:00:00Z`).toLocaleDateString(locale.value, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  ),
  datasets: [{
    data: props.series.map((p) => Number(p.amount) / 1_000_000),
    backgroundColor: `${color.value}99`,
    hoverBackgroundColor: color.value,
    borderRadius: 3,
    maxBarThickness: 18,
  }],
}));

const options = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        label: (ctx: { parsed: { y: number | null } }) => fmt(BigInt(Math.round((ctx.parsed.y ?? 0) * 1_000_000))),
      },
    },
  },
  scales: {
    x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 11 }, maxTicksLimit: 8 } },
    y: {
      beginAtZero: true,
      grid: { color: 'rgba(148,163,184,0.08)' },
      ticks: { color: '#64748b', font: { size: 11 }, callback: (v: string | number) => fmt(BigInt(Math.round(Number(v) * 1_000_000))) },
    },
  },
}));

const hasData = computed(() => props.series.some((p) => Number(p.amount) > 0));
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
