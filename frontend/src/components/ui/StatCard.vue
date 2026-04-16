<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{
  label: string;
  value: string | number;
  loading?: boolean;
  icon?: Component;
  trend?: string;
  trendPositive?: boolean;
  sub?: string;
}>();
</script>

<template>
  <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5 backdrop-blur-sm">
    <div class="flex items-start justify-between mb-3">
      <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">{{ label }}</p>
      <div v-if="icon" class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center">
        <component :is="icon" class="w-4 h-4 text-primary-400" />
      </div>
    </div>
    <div v-if="loading" class="h-8 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-lg w-24 mb-1" />
    <p v-else class="text-2xl font-bold text-surface-50 tabular-nums">{{ value }}</p>
    <div v-if="trend || sub" class="mt-1.5 flex items-center gap-1.5">
      <span v-if="trend" :class="['text-xs font-medium', trendPositive ? 'text-emerald-400' : 'text-red-400']">{{ trend }}</span>
      <span v-if="sub" class="text-xs text-surface-500">{{ sub }}</span>
    </div>
  </div>
</template>
