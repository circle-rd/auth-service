<script setup lang="ts">
defineProps<{
  modelValue: boolean;
  label?: string;
  description?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();
</script>

<template>
  <div class="flex items-start gap-3">
    <button
      type="button"
      role="switch"
      :aria-checked="modelValue"
      :disabled="disabled"
      @click="emit('update:modelValue', !modelValue)"
      :class="[
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent',
        'transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-900',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        modelValue ? 'bg-primary-600' : 'bg-surface-600',
      ]"
    >
      <span
        :class="[
          'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out',
          modelValue ? 'translate-x-4' : 'translate-x-0',
        ]"
      />
    </button>
    <div v-if="label || description">
      <p v-if="label" class="text-sm font-medium text-surface-200">{{ label }}</p>
      <p v-if="description" class="text-xs text-surface-500 mt-0.5">{{ description }}</p>
    </div>
  </div>
</template>
