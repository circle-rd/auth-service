<script setup lang="ts">
import { useId } from 'vue';

defineProps<{
  prefix: string;
  modelValue: string;
  label?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  readonly?: boolean;
  required?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const inputId = useId();
</script>

<template>
  <div class="space-y-1.5">
    <label v-if="label" :for="inputId" class="block text-xs font-medium text-surface-400 uppercase tracking-wide">
      {{ label }}
      <span v-if="required" class="text-red-400 ml-0.5">*</span>
    </label>
    <div
      :class="[
        'flex items-stretch rounded-lg border bg-surface-800 transition-all duration-150 overflow-hidden',
        'focus-within:ring-2 focus-within:ring-primary-500/50 focus-within:border-primary-500',
        error ? 'border-red-500/60' : 'border-surface-600 hover:border-surface-500',
        readonly ? 'opacity-70' : '',
      ]"
    >
      <span
        class="flex items-center px-3 text-sm font-mono text-surface-400 bg-surface-900/70 border-r border-surface-600 select-none"
        data-testid="uri-prefix"
      >
        {{ prefix }}://
      </span>
      <input
        :id="inputId"
        :value="modelValue"
        :placeholder="placeholder"
        :readonly="readonly"
        :required="required"
        autocomplete="off"
        spellcheck="false"
        class="flex-1 min-w-0 bg-transparent px-3 py-2 text-sm font-mono text-surface-100 placeholder:text-surface-500 focus:outline-none"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
    <p v-else-if="hint" class="text-xs text-surface-500">{{ hint }}</p>
  </div>
</template>
