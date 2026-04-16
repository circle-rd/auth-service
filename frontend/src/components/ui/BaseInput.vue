<script setup lang="ts">
defineProps<{
  label?: string;
  error?: string;
  hint?: string;
  modelValue?: string | number;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  required?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();
</script>

<template>
  <div class="space-y-1.5">
    <label v-if="label" class="block text-xs font-medium text-surface-400 uppercase tracking-wide">
      {{ label }}
      <span v-if="required" class="text-red-400 ml-0.5">*</span>
    </label>
    <input
      :value="modelValue"
      :type="type || 'text'"
      :placeholder="placeholder"
      :disabled="disabled"
      :required="required"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      :class="[
        'w-full rounded-lg px-3 py-2 text-sm bg-surface-800 border transition-all duration-150',
        'text-surface-100 placeholder:text-surface-500',
        'focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        error
          ? 'border-red-500/60 focus:border-red-500 focus:ring-red-500/30'
          : 'border-surface-600 hover:border-surface-500',
      ]"
    />
    <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
    <p v-else-if="hint" class="text-xs text-surface-500">{{ hint }}</p>
  </div>
</template>
