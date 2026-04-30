<script setup lang="ts">
defineProps<{
  title: string;
  message?: string;
  icon?: string;
}>();
</script>

<template>
  <div class="flex flex-col items-center justify-center py-16 px-8 text-center">
    <div class="w-16 h-16 rounded-2xl bg-surface-800/80 flex items-center justify-center mb-4 border border-surface-700/50">
      <slot name="icon">
        <svg class="w-8 h-8 text-surface-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10" />
        </svg>
      </slot>
    </div>
    <h3 class="text-sm font-semibold text-surface-200 mb-1">{{ title }}</h3>
    <p v-if="message" class="text-sm text-surface-500 max-w-sm">{{ message }}</p>
    <div v-if="$slots.action" class="mt-4">
      <slot name="action" />
    </div>
  </div>
</template>
