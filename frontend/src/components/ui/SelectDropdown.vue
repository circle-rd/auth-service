<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import type { CSSProperties } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check } from 'lucide-vue-next';
import type { SelectOption } from '@/types/select';
import SelectOptionContent from './SelectOptionContent.vue';

const MAX_HEIGHT = 260;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;

const props = defineProps<{
  open: boolean;
  anchorEl: HTMLElement | null;
  options: SelectOption[];
  modelValue?: string;
  loading?: boolean;
}>();

const emit = defineEmits<{
  select: [option: SelectOption];
  close: [];
}>();

const { t } = useI18n();
const listboxId = useId();
const panelEl = ref<HTMLElement | null>(null);
const position = ref<CSSProperties>({});
const highlightedIndex = ref(-1);

function optionId(index: number): string {
  return `${listboxId}-option-${index}`;
}

const activeId = ref<string | undefined>(undefined);

// Fixed positioning on <body> escapes the overflow clipping of modal containers.
function updatePosition() {
  if (!props.anchorEl) return;
  const rect = props.anchorEl.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
  const above = rect.top - ANCHOR_GAP - VIEWPORT_MARGIN;
  const contentHeight = Math.min(MAX_HEIGHT, panelEl.value?.scrollHeight ?? MAX_HEIGHT);
  const placeAbove = below < contentHeight && above > below;
  position.value = {
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    maxHeight: `${Math.min(MAX_HEIGHT, placeAbove ? above : below)}px`,
    ...(placeAbove
      ? { bottom: `${window.innerHeight - rect.top + ANCHOR_GAP}px` }
      : { top: `${rect.bottom + ANCHOR_GAP}px` }),
  };
}

function resetHighlight() {
  const selected = props.options.findIndex((o) => o.value === props.modelValue && !o.disabled);
  highlightedIndex.value = selected >= 0 ? selected : props.options.findIndex((o) => !o.disabled);
}

function moveHighlight(delta: 1 | -1) {
  const count = props.options.length;
  if (count === 0) return;
  let index = highlightedIndex.value;
  for (let step = 0; step < count; step++) {
    index = (index + delta + count) % count;
    if (!props.options[index].disabled) {
      highlightedIndex.value = index;
      return;
    }
  }
}

function choose(option: SelectOption) {
  if (option.disabled) return;
  emit('select', option);
}

function selectHighlighted(): boolean {
  const option = props.options[highlightedIndex.value];
  if (!option) return false;
  choose(option);
  return true;
}

// Returns true when the key was consumed. Escape is stopped here so an enclosing modal stays open.
function handleKeydown(e: KeyboardEvent): boolean {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      moveHighlight(1);
      return true;
    case 'ArrowUp':
      e.preventDefault();
      moveHighlight(-1);
      return true;
    case 'Enter':
      e.preventDefault();
      return selectHighlighted();
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      emit('close');
      return true;
    case 'Tab':
      emit('close');
      return false;
    default:
      return false;
  }
}

function onDocumentMouseDown(e: MouseEvent) {
  const target = e.target as Node;
  if (props.anchorEl?.contains(target) || panelEl.value?.contains(target)) return;
  emit('close');
}

function attach() {
  window.addEventListener('resize', updatePosition);
  window.addEventListener('scroll', updatePosition, true);
  document.addEventListener('mousedown', onDocumentMouseDown);
}

function detach() {
  window.removeEventListener('resize', updatePosition);
  window.removeEventListener('scroll', updatePosition, true);
  document.removeEventListener('mousedown', onDocumentMouseDown);
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) {
      detach();
      activeId.value = undefined;
      return;
    }
    resetHighlight();
    updatePosition();
    attach();
    await nextTick();
    updatePosition();
  },
  { immediate: true },
);

watch(
  () => props.options,
  async () => {
    resetHighlight();
    await nextTick();
    updatePosition();
  },
);

watch([highlightedIndex, () => props.open], async ([index, isOpen]) => {
  activeId.value = isOpen && index >= 0 ? optionId(index) : undefined;
  if (!activeId.value) return;
  await nextTick();
  document.getElementById(activeId.value)?.scrollIntoView({ block: 'nearest' });
});

onBeforeUnmount(detach);

defineExpose({ handleKeydown, selectHighlighted, activeId, listboxId });
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-75 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        ref="panelEl"
        :style="position"
        class="fixed z-[90] overflow-y-auto rounded-lg bg-surface-800 border border-surface-600 shadow-xl shadow-black/40"
        @mousedown.prevent
      >
        <div v-if="loading" class="px-3 py-3 text-xs text-surface-500 text-center">{{ t('common.loading') }}</div>
        <div v-else-if="options.length === 0" class="px-3 py-3 text-xs text-surface-500 text-center">{{ t('common.noResults') }}</div>
        <ul v-else :id="listboxId" role="listbox" class="py-1">
          <li
            v-for="(option, index) in options"
            :id="optionId(index)"
            :key="option.value"
            role="option"
            :aria-selected="modelValue === option.value"
            :aria-disabled="option.disabled || undefined"
            :class="[
              'flex items-center gap-2 px-3 py-2 text-sm transition-colors',
              option.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
              modelValue === option.value
                ? 'bg-primary-600/15 text-primary-300'
                : index === highlightedIndex
                  ? 'bg-surface-700/50 text-surface-100'
                  : 'text-surface-200',
            ]"
            @click="choose(option)"
            @mousemove="!option.disabled && (highlightedIndex = index)"
          >
            <SelectOptionContent :option="option" class="flex-1" />
            <Check v-if="modelValue === option.value" class="w-3.5 h-3.5 text-primary-400 shrink-0" />
          </li>
        </ul>
      </div>
    </Transition>
  </Teleport>
</template>
