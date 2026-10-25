<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { ChevronDown } from 'lucide-vue-next';
import type { SelectOption } from '@/types/select';
import SelectDropdown from './SelectDropdown.vue';
import SelectOptionContent from './SelectOptionContent.vue';

const props = withDefaults(defineProps<{
  label?: string;
  error?: string;
  modelValue?: string;
  disabled?: boolean;
  required?: boolean;
  options: SelectOption[];
  placeholder?: string;
  size?: 'sm' | 'md';
}>(), {
  size: 'md',
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const triggerId = useId();
const triggerEl = ref<HTMLButtonElement | null>(null);
const dropdownRef = ref<InstanceType<typeof SelectDropdown> | null>(null);
const open = ref(false);

const selectedOption = computed(() => props.options.find((o) => o.value === props.modelValue));

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
}

function onSelect(option: SelectOption) {
  emit('update:modelValue', option.value);
  open.value = false;
  triggerEl.value?.focus();
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return;
  if (!open.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      open.value = true;
    }
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();
    dropdownRef.value?.selectHighlighted();
    return;
  }
  dropdownRef.value?.handleKeydown(e);
}
</script>

<template>
  <div class="space-y-1.5">
    <label v-if="label" :for="triggerId" class="block text-xs font-medium text-surface-400 uppercase tracking-wide">
      {{ label }}
      <span v-if="required" class="text-red-400 ml-0.5">*</span>
    </label>
    <button
      :id="triggerId"
      ref="triggerEl"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="dropdownRef?.listboxId"
      :aria-activedescendant="open ? dropdownRef?.activeId : undefined"
      :aria-invalid="error ? true : undefined"
      :disabled="disabled"
      :class="[
        'flex items-center gap-2 w-full rounded-lg text-left bg-surface-800 border transition-all duration-150',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-2 text-sm',
        'text-surface-100 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        open ? 'border-primary-500 ring-2 ring-primary-500/50' : error ? 'border-red-500/60' : 'border-surface-600 hover:border-surface-500',
      ]"
      @click="toggle"
      @keydown="onKeydown"
    >
      <SelectOptionContent v-if="selectedOption" :option="selectedOption" :show-description="false" class="flex-1" />
      <span v-else class="flex-1 truncate text-surface-500">{{ placeholder }}</span>
      <ChevronDown class="w-3.5 h-3.5 text-surface-500 shrink-0 transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>
    <SelectDropdown
      ref="dropdownRef"
      :open="open"
      :anchor-el="triggerEl"
      :options="options"
      :model-value="modelValue"
      @select="onSelect"
      @close="open = false"
    />
    <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
  </div>
</template>
