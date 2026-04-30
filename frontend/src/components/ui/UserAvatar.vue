<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  name?: string | null;
  image?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}>(), {
  size: 'md',
});

const sizeClasses = {
  xs: 'w-6 h-6 text-xs',
  sm: 'w-8 h-8 text-sm',
  md: 'w-9 h-9 text-sm',
  lg: 'w-12 h-12 text-base',
  xl: 'w-16 h-16 text-xl',
};

const initials = computed(() => {
  if (!props.name) return '?';
  const parts = props.name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
});

const colors = [
  'bg-blue-600',
  'bg-emerald-600',
  'bg-amber-600',
  'bg-rose-600',
  'bg-teal-600',
  'bg-sky-600',
];

const bgColor = computed(() => {
  if (!props.name) return colors[0];
  const idx = props.name.charCodeAt(0) % colors.length;
  return colors[idx];
});
</script>

<template>
  <div :class="['rounded-full shrink-0 overflow-hidden', sizeClasses[size]]">
    <img
      v-if="image"
      :src="image"
      :alt="name ?? ''"
      class="w-full h-full object-cover"
    />
    <div
      v-else
      :class="['w-full h-full flex items-center justify-center font-semibold text-white', bgColor]"
    >
      {{ initials }}
    </div>
  </div>
</template>
