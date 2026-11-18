<script setup lang="ts">
import { computed } from 'vue';

export interface RankItem {
  key: string;
  label: string;
  sub?: string;
  value: number;
  // Tail of the row, for example "3 denied".
  note?: string;
}

const props = withDefaults(defineProps<{
  title: string;
  items: RankItem[];
  empty: string;
  barClass?: string;
}>(), { barClass: 'bg-primary-500/60' });

const max = computed(() => Math.max(1, ...props.items.map((item) => item.value)));
</script>

<template>
  <section class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
    <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-3">{{ title }}</h3>
    <p v-if="items.length === 0" class="text-sm text-surface-500">{{ empty }}</p>
    <ul v-else class="space-y-3">
      <li v-for="item in items" :key="item.key">
        <div class="flex items-baseline justify-between gap-3">
          <p class="text-sm text-surface-200 truncate">{{ item.label }}</p>
          <p class="text-xs text-surface-400 tabular-nums shrink-0">
            {{ item.value }}<span v-if="item.note" class="text-surface-500"> · {{ item.note }}</span>
          </p>
        </div>
        <p v-if="item.sub" class="text-[11px] font-mono text-surface-500 truncate">{{ item.sub }}</p>
        <div class="mt-1 h-1.5 rounded-full bg-surface-800 overflow-hidden">
          <div :class="['h-full rounded-full', barClass]" :style="{ width: `${(item.value / max) * 100}%` }" />
        </div>
      </li>
    </ul>
  </section>
</template>
