<script setup lang="ts">
defineProps<{
  label?: string;
  error?: string;
  modelValue?: string;
  disabled?: boolean;
  required?: boolean;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
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
    <select
      :value="modelValue"
      :disabled="disabled"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
      :class="[
        'w-full rounded-lg px-3 py-2 text-sm bg-surface-800 border transition-all duration-150',
        'text-surface-100 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        error
          ? 'border-red-500/60'
          : 'border-surface-600 hover:border-surface-500',
      ]"
    >
      <option v-if="placeholder" value="" disabled :selected="!modelValue">{{ placeholder }}</option>
      <option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
    </select>
    <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
  </div>
</template>
