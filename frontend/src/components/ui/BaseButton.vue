<script setup lang="ts">
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg';

withDefaults(defineProps<{
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}>(), {
  variant: 'primary',
  size: 'md',
  loading: false,
  disabled: false,
  type: 'button',
});

const variantClasses: Record<Variant, string> = {
  primary: 'bg-primary-600 hover:bg-primary-500 text-white shadow-sm shadow-primary-900/30 focus-visible:outline-primary-500',
  secondary: 'bg-surface-700 hover:bg-surface-600 text-surface-100 shadow-sm focus-visible:outline-surface-500',
  ghost: 'text-surface-300 hover:text-surface-100 hover:bg-surface-700/60 focus-visible:outline-surface-500',
  danger: 'bg-red-600 hover:bg-red-500 text-white shadow-sm shadow-red-900/30 focus-visible:outline-red-500',
  outline: 'border border-surface-600 text-surface-300 hover:border-surface-400 hover:text-surface-100 focus-visible:outline-surface-500',
};

const sizeClasses: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
  lg: 'px-5 py-2.5 text-sm gap-2',
};
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :class="[
      'inline-flex items-center justify-center rounded-lg font-medium transition-all duration-150',
      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      variantClasses[variant],
      sizeClasses[size],
    ]"
  >
    <svg v-if="loading" class="animate-spin -ml-0.5 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
    <slot />
  </button>
</template>
