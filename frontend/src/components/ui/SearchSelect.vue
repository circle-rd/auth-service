<script setup lang="ts" generic="T extends { value: string; label: string; sublabel?: string }">
import { ref, shallowRef, watch, onMounted, onBeforeUnmount } from 'vue';
import { Search, X, ChevronDown } from 'lucide-vue-next';

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
  placeholder: 'Search…',
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const inputEl = ref<HTMLInputElement | null>(null);
const containerEl = ref<HTMLDivElement | null>(null);
const query = ref('');
const options = shallowRef<T[]>([]);
const loading = ref(false);
const open = ref(false);
const selectedLabel = ref('');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// When modelValue is set externally but we have no label yet, do a silent initial search
onMounted(async () => {
  if (props.modelValue) {
    const initial = await props.loadOptions('');
    const found = initial.find(o => o.value === props.modelValue);
    if (found) selectedLabel.value = found.label;
  }
});

function openDropdown() {
  if (props.disabled) return;
  open.value = true;
  doSearch(query.value);
  inputEl.value?.focus();
}

function closeDropdown() {
  open.value = false;
}

function handleInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doSearch(query.value), props.debounce);
}

async function doSearch(term: string) {
  loading.value = true;
  try {
    options.value = await props.loadOptions(term);
  } finally {
    loading.value = false;
  }
}

function select(option: T) {
  emit('update:modelValue', option.value);
  selectedLabel.value = option.label;
  query.value = '';
  open.value = false;
}

function clear(e: MouseEvent) {
  e.stopPropagation();
  emit('update:modelValue', '');
  selectedLabel.value = '';
  query.value = '';
  options.value = [];
}

// Close on click outside
function handleClickOutside(e: MouseEvent) {
  if (containerEl.value && !containerEl.value.contains(e.target as Node)) {
    closeDropdown();
  }
}

onMounted(() => document.addEventListener('mousedown', handleClickOutside));
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  if (debounceTimer) clearTimeout(debounceTimer);
});

watch(() => props.modelValue, (val) => {
  if (!val) selectedLabel.value = '';
});
</script>

<template>
  <div ref="containerEl" class="space-y-1.5 relative">
    <label v-if="label" class="block text-xs font-medium text-surface-400 uppercase tracking-wide">
      {{ label }}
      <span v-if="required" class="text-red-400 ml-0.5">*</span>
    </label>

    <!-- Trigger / selected display -->
    <div
      :class="[
        'flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm bg-surface-800 border transition-all duration-150 cursor-pointer',
        'text-surface-100 focus-within:ring-2 focus-within:ring-primary-500/50 focus-within:border-primary-500',
        disabled ? 'opacity-50 cursor-not-allowed' : 'border-surface-600 hover:border-surface-500',
        open ? 'border-primary-500 ring-2 ring-primary-500/50' : '',
      ]"
      @click="openDropdown"
    >
      <Search class="w-3.5 h-3.5 text-surface-500 shrink-0" />
      <template v-if="open">
        <input
          ref="inputEl"
          :value="query"
          @input="handleInput"
          :placeholder="placeholder"
          class="flex-1 bg-transparent outline-none text-surface-100 placeholder:text-surface-500"
          :disabled="disabled"
          @click.stop
        />
      </template>
      <template v-else>
        <span class="flex-1 truncate" :class="modelValue ? 'text-surface-100' : 'text-surface-500'">
          {{ modelValue ? selectedLabel || modelValue : placeholder }}
        </span>
      </template>
      <button v-if="modelValue && !disabled" @click="clear" class="text-surface-500 hover:text-surface-300 transition-colors">
        <X class="w-3.5 h-3.5" />
      </button>
      <ChevronDown v-else class="w-3.5 h-3.5 text-surface-500 shrink-0 transition-transform" :class="open ? 'rotate-180' : ''" />
    </div>

    <!-- Dropdown -->
    <div
      v-if="open"
      class="absolute z-50 top-full mt-1 w-full rounded-lg bg-surface-800 border border-surface-600 shadow-xl overflow-hidden"
    >
      <div v-if="loading" class="px-3 py-3 text-xs text-surface-500 text-center">Loading…</div>
      <div v-else-if="options.length === 0" class="px-3 py-3 text-xs text-surface-500 text-center">No results</div>
      <ul v-else class="max-h-52 overflow-y-auto py-1">
        <li
          v-for="option in options"
          :key="option.value"
          @mousedown.prevent="select(option)"
          :class="[
            'flex flex-col px-3 py-2 cursor-pointer transition-colors hover:bg-surface-700/50 text-sm',
            modelValue === option.value ? 'bg-primary-600/20 text-primary-300' : 'text-surface-200',
          ]"
        >
          <span>{{ option.label }}</span>
          <span v-if="option.sublabel" class="text-xs text-surface-500">{{ option.sublabel }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
