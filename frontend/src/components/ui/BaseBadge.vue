<script setup lang="ts">
type Variant = 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'primary';
type Size = 'sm' | 'md';

withDefaults(defineProps<{
  variant?: Variant;
  size?: Size;
  dot?: boolean;
}>(), {
  variant: 'neutral',
  size: 'sm',
  dot: false,
});

const variantClasses: Record<Variant, string> = {
  success: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
  error: 'bg-red-500/10 text-red-400 ring-red-500/20',
  warning: 'bg-amber-500/10 text-amber-400 ring-amber-500/20',
  info: 'bg-sky-500/10 text-sky-400 ring-sky-500/20',
  neutral: 'bg-surface-700/50 text-surface-300 ring-surface-600/30',
  primary: 'bg-primary-500/10 text-primary-400 ring-primary-500/20',
};

const dotClasses: Record<Variant, string> = {
  success: 'bg-emerald-400',
  error: 'bg-red-400',
  warning: 'bg-amber-400',
  info: 'bg-sky-400',
  neutral: 'bg-surface-400',
  primary: 'bg-primary-400',
};

const sizeClasses: Record<Size, string> = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
};
</script>

<template>
  <span
    :class="[
      'inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset',
      variantClasses[variant],
      sizeClasses[size],
    ]"
  >
    <span v-if="dot" :class="['w-1.5 h-1.5 rounded-full', dotClasses[variant]]" />
    <slot />
  </span>
</template>
