<script setup lang="ts" generic="T extends SelectOption">
import { computed, ref, shallowRef, watch, onMounted, onBeforeUnmount, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { Search, X, ChevronDown } from 'lucide-vue-next';
import type { SelectOption } from '@/types/select';
import SelectDropdown from './SelectDropdown.vue';
import SelectOptionContent from './SelectOptionContent.vue';

const props = withDefaults(defineProps<{
  modelValue?: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** Called when search term changes; must return matching options */
  loadOptions: (search: string) => Promise<T[]>;
  /** Debounce delay in ms */
  debounce?: number;
}>(), {
  debounce: 300,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const { t } = useI18n();
const inputId = useId();
const inputEl = ref<HTMLInputElement | null>(null);
const triggerEl = ref<HTMLDivElement | null>(null);
const dropdownRef = ref<InstanceType<typeof SelectDropdown> | null>(null);
const query = ref('');
const options = shallowRef<T[]>([]);
const selected = shallowRef<T | null>(null);
const loading = ref(false);
const open = ref(false);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const placeholderText = computed(() => props.placeholder ?? t('common.searchPlaceholder'));

// When modelValue is set externally but we have no option yet, do a silent initial search
onMounted(async () => {
  if (props.modelValue) {
    const initial = await props.loadOptions('');
    selected.value = initial.find(o => o.value === props.modelValue) ?? null;
  }
});

function openDropdown() {
  if (props.disabled) return;
  open.value = true;
  void doSearch(query.value);
}

function closeDropdown() {
  open.value = false;
  query.value = '';
}

function handleInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void doSearch(query.value), props.debounce);
}

async function doSearch(term: string) {
  loading.value = true;
  try {
    options.value = await props.loadOptions(term);
  } finally {
    loading.value = false;
  }
}

function select(option: SelectOption) {
  const chosen = options.value.find(o => o.value === option.value) ?? null;
  emit('update:modelValue', option.value);
  selected.value = chosen;
  closeDropdown();
}

function clear(e: MouseEvent) {
  e.stopPropagation();
  emit('update:modelValue', '');
  selected.value = null;
  query.value = '';
  options.value = [];
}

function handleKeydown(e: KeyboardEvent) {
  if (!open.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openDropdown();
    }
    return;
  }
  dropdownRef.value?.handleKeydown(e);
}

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

watch(() => props.modelValue, (val) => {
  if (!val) selected.value = null;
});

// Post-flush: the input only exists once the open state has rendered.
watch(open, (isOpen) => {
  if (isOpen) inputEl.value?.focus();
}, { flush: 'post' });
</script>

<template>
  <div class="space-y-1.5">
    <label v-if="label" :for="inputId" class="block text-xs font-medium text-surface-400 uppercase tracking-wide">
      {{ label }}
      <span v-if="required" class="text-red-400 ml-0.5">*</span>
    </label>

    <div
      ref="triggerEl"
      :class="[
        'flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm bg-surface-800 border transition-all duration-150 cursor-pointer',
        'text-surface-100 focus-within:ring-2 focus-within:ring-primary-500/50 focus-within:border-primary-500',
        disabled ? 'opacity-50 cursor-not-allowed' : 'border-surface-600 hover:border-surface-500',
        open ? 'border-primary-500 ring-2 ring-primary-500/50' : '',
      ]"
      @click="openDropdown"
    >
      <Search class="w-3.5 h-3.5 text-surface-500 shrink-0" />
      <input
        v-if="open"
        :id="inputId"
        ref="inputEl"
        :value="query"
        :placeholder="selected?.label ?? placeholderText"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded="true"
        :aria-controls="dropdownRef?.listboxId"
        :aria-activedescendant="dropdownRef?.activeId"
        aria-autocomplete="list"
        autocomplete="off"
        class="flex-1 min-w-0 bg-transparent outline-none text-surface-100 placeholder:text-surface-500"
        :disabled="disabled"
        @input="handleInput"
        @keydown="handleKeydown"
        @click.stop
      />
      <button
        v-else
        :id="inputId"
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded="false"
        :disabled="disabled"
        class="flex-1 min-w-0 flex items-center text-left outline-none"
        @keydown="handleKeydown"
      >
        <SelectOptionContent v-if="selected" :option="selected" :show-description="false" />
        <span v-else class="truncate" :class="modelValue ? 'text-surface-100' : 'text-surface-500'">
          {{ modelValue || placeholderText }}
        </span>
      </button>
      <button
        v-if="modelValue && !disabled"
        type="button"
        :aria-label="t('common.clear')"
        class="text-surface-500 hover:text-surface-300 transition-colors"
        @click="clear"
      >
        <X class="w-3.5 h-3.5" />
      </button>
      <ChevronDown v-else class="w-3.5 h-3.5 text-surface-500 shrink-0 transition-transform" :class="open ? 'rotate-180' : ''" />
    </div>

    <SelectDropdown
      ref="dropdownRef"
      :open="open"
      :anchor-el="triggerEl"
      :options="options"
      :model-value="modelValue"
      :loading="loading && options.length === 0"
      @select="select"
      @close="closeDropdown"
    />
  </div>
</template>
