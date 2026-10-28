<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  iconUrl?: string | null;
  letter?: string;
  name?: string;
  color?: string;
  shape?: 'circle' | 'square';
  // Sizing of the fallback letter, for icons larger than the default.
  letterClass?: string;
}>(), {
  shape: 'square',
  letterClass: 'text-xl sm:text-2xl',
});

const letterDisplay = computed(() => {
  if (props.letter) return props.letter;
  if (props.name) return props.name[0].toUpperCase();
  return '?';
});

const defaultColors = [
  'from-blue-600/30 to-blue-800/20 border-blue-700/30 text-blue-300',
  'from-emerald-600/30 to-emerald-800/20 border-emerald-700/30 text-emerald-300',
  'from-amber-600/30 to-amber-800/20 border-amber-700/30 text-amber-300',
  'from-rose-600/30 to-rose-800/20 border-rose-700/30 text-rose-300',
  'from-teal-600/30 to-teal-800/20 border-teal-700/30 text-teal-300',
  'from-sky-600/30 to-sky-800/20 border-sky-700/30 text-sky-300',
];

const autoColor = computed(() => {
  if (props.color) return props.color;
  return defaultColors[letterDisplay.value.charCodeAt(0) % defaultColors.length];
});
</script>

<template>
  <div
    :class="[
      'shrink-0 overflow-hidden flex items-center justify-center border bg-gradient-to-br',
      shape === 'circle' ? 'rounded-full' : 'rounded-lg',
      !iconUrl ? autoColor : 'bg-surface-800 border-surface-700/50',
    ]"
  >
    <img v-if="iconUrl" :src="iconUrl" class="w-full h-full object-cover" :alt="name ?? ''" />
    <span v-else :class="[letterClass, 'font-bold select-none']">{{ letterDisplay }}</span>
  </div>
</template>
