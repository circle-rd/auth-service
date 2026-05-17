<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: string;
}>(), {
  width: 80,
  height: 24,
  color: '#10b981',
  fill: 'rgba(16,185,129,0.15)',
});

const path = computed(() => {
  const vs = props.values;
  if (!vs.length) return '';
  const max = Math.max(...vs, 1);
  const min = Math.min(...vs, 0);
  const range = max - min || 1;
  const stepX = props.width / Math.max(vs.length - 1, 1);
  return vs.map((v, i) => {
    const x = i * stepX;
    const y = props.height - ((v - min) / range) * props.height;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
});

const areaPath = computed(() => {
  if (!path.value) return '';
  return `${path.value} L${props.width},${props.height} L0,${props.height} Z`;
});

const empty = computed(() => props.values.length === 0 || props.values.every(v => v === 0));
</script>

<template>
  <svg
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    class="block"
    role="img"
    aria-label="Activity sparkline"
  >
    <template v-if="!empty">
      <path :d="areaPath" :fill="fill" />
      <path :d="path" :stroke="color" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round" />
    </template>
    <line
      v-else
      :x1="0"
      :y1="height / 2"
      :x2="width"
      :y2="height / 2"
      stroke="rgba(148,163,184,0.25)"
      stroke-width="1"
      stroke-dasharray="2 2"
    />
  </svg>
</template>
