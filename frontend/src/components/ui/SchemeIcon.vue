<script setup lang="ts">
import { computed } from 'vue';
import { resolveSchemeIcon, schemeTone } from '@/utils/schemeIcons';

const props = withDefaults(defineProps<{
  icon?: string | null;
  scheme?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}>(), { size: 'md' });

const resolved = computed(() => resolveSchemeIcon(props.icon, props.scheme));
const tone = computed(() => schemeTone(props.scheme));

const SIZES = {
  sm: { box: 'w-7 h-7 rounded-lg', glyph: 'w-3.5 h-3.5' },
  md: { box: 'w-10 h-10 rounded-xl', glyph: 'w-5 h-5' },
  lg: { box: 'w-14 h-14 rounded-2xl', glyph: 'w-7 h-7' },
  xl: { box: 'w-20 h-20 rounded-3xl', glyph: 'w-10 h-10' },
} as const;
</script>

<template>
  <span
    :class="[
      'shrink-0 overflow-hidden inline-flex items-center justify-center border bg-gradient-to-br',
      SIZES[size].box,
      resolved.kind === 'url' ? 'bg-surface-800 border-surface-700/50' : tone,
    ]"
    aria-hidden="true"
  >
    <img v-if="resolved.kind === 'url'" :src="resolved.url" alt="" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
    <component :is="resolved.component" v-else :class="SIZES[size].glyph" />
  </span>
</template>
