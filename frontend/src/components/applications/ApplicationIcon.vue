<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    name: string;
    icon?: string | null;
    size?: 'xs' | 'md';
  }>(),
  { size: 'xs' },
);

const sizeClasses = {
  xs: 'w-6 h-6 rounded-md text-[9px]',
  md: 'w-10 h-10 rounded-xl text-sm',
};

const letters = computed(() => {
  const words = props.name.trim().split(/\s+/).filter(Boolean);
  const picked =
    words.length >= 2
      ? [Array.from(words[0]!)[0], Array.from(words[1]!)[0]].join('')
      : Array.from(props.name.trim()).slice(0, 2).join('');
  return (picked || '?').toUpperCase();
});
</script>

<template>
  <div
    :class="[
      'shrink-0 overflow-hidden bg-surface-800 flex items-center justify-center',
      sizeClasses[size],
    ]"
  >
    <img
      v-if="icon"
      :src="icon"
      :alt="name"
      class="w-full h-full object-cover"
    />
    <span v-else class="font-bold text-surface-400 leading-none select-none">
      {{ letters }}
    </span>
  </div>
</template>
