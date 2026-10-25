<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    length?: number;
    disabled?: boolean;
    error?: string;
    label?: string;
    autofocus?: boolean;
  }>(),
  { length: 6, autofocus: true },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  complete: [value: string];
}>();

const cells = ref<HTMLInputElement[]>([]);
const shaking = ref(false);

const digits = computed(() => Array.from({ length: props.length }, (_, i) => props.modelValue[i] ?? ''));
// A thin separator in the middle of an even-length code (123 · 456).
const middle = computed(() => (props.length % 2 === 0 ? props.length / 2 : -1));

function focusCell(index: number) {
  const target = cells.value[Math.max(0, Math.min(index, props.length - 1))];
  target?.focus();
  target?.select();
}

function commit(next: string, focusIndex: number) {
  emit('update:modelValue', next);
  nextTick(() => focusCell(focusIndex));
  if (next.length === props.length) emit('complete', next);
}

// Writes `incoming` digits from `start`, which covers typing, paste and the
// one-time-code autofill of mobile keyboards (a whole code lands in one cell).
// The code never has a gap: a cell past the end writes at the first empty one.
function write(start: number, incoming: string) {
  const clean = incoming.replace(/\D/g, '');
  if (!clean) return;
  const at = Math.min(start, props.modelValue.length);
  const next = (props.modelValue.slice(0, at) + clean + props.modelValue.slice(at + clean.length)).slice(0, props.length);
  commit(next, Math.min(at + clean.length, props.length - 1));
}

function onInput(index: number, event: Event) {
  const input = event.target as HTMLInputElement;
  const typed = (event as InputEvent).inputType === 'insertText';
  // Typing over a filled cell leaves two characters: the new one is the last.
  const raw = typed && input.value.length > 1 ? input.value.slice(-1) : input.value;
  input.value = digits.value[index] ?? '';
  const clean = raw.replace(/\D/g, '');
  if (clean === '') {
    if (raw === '') remove(index);
    return;
  }
  write(index, clean);
}

function remove(index: number) {
  emit('update:modelValue', props.modelValue.slice(0, index) + props.modelValue.slice(index + 1));
}

function onKeydown(index: number, event: KeyboardEvent) {
  if (event.key === 'Backspace') {
    event.preventDefault();
    if (digits.value[index]) {
      remove(index);
    } else if (index > 0) {
      remove(index - 1);
      focusCell(index - 1);
    }
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    focusCell(index - 1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    focusCell(index + 1);
  }
}

function onPaste(index: number, event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text') ?? '';
  if (!text.replace(/\D/g, '')) return;
  event.preventDefault();
  write(props.modelValue.length >= props.length ? 0 : index, text);
}

watch(
  () => props.error,
  (message) => {
    if (!message) return;
    shaking.value = true;
    setTimeout(() => (shaking.value = false), 400);
  },
);

// An emptied code (after a refusal, or a mode switch) puts the caret back on the first cell.
watch(
  () => props.modelValue,
  (value, previous) => {
    if (value === '' && previous !== '') nextTick(() => focusCell(0));
  },
);

onMounted(() => {
  if (props.autofocus) setTimeout(() => focusCell(0), 50);
});

defineExpose({ focus: () => focusCell(0) });
</script>

<template>
  <div class="space-y-1.5">
    <label v-if="label" class="block text-xs font-medium text-surface-400 uppercase tracking-wide text-center">
      {{ label }}
    </label>
    <div
      class="flex items-center justify-center gap-2"
      :class="{ 'otp-shake': shaking }"
      role="group"
      :aria-label="label"
    >
      <template v-for="(digit, i) in digits" :key="i">
        <span v-if="i === middle" class="w-3 h-px bg-surface-600 shrink-0" aria-hidden="true" />
        <input
          :ref="(el) => { if (el) cells[i] = el as HTMLInputElement; }"
          :value="digit"
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          :maxlength="length"
          :autocomplete="i === 0 ? 'one-time-code' : 'off'"
          :aria-label="`${i + 1}`"
          :disabled="disabled"
          :class="[
            'w-10 h-12 text-center text-xl font-semibold tabular-nums rounded-lg bg-surface-800 border transition-all duration-150',
            'text-surface-100 focus:outline-none focus:ring-2 disabled:opacity-50 disabled:cursor-not-allowed',
            error
              ? 'border-red-500/60 focus:border-red-500 focus:ring-red-500/30'
              : digit
                ? 'border-primary-500/60 bg-surface-700/60 focus:border-primary-500 focus:ring-primary-500/50'
                : 'border-surface-600 hover:border-surface-500 focus:border-primary-500 focus:ring-primary-500/50',
          ]"
          @input="onInput(i, $event)"
          @keydown="onKeydown(i, $event)"
          @paste="onPaste(i, $event)"
          @focus="($event.target as HTMLInputElement).select()"
        />
      </template>
    </div>
    <p v-if="error" class="text-xs text-red-400 text-center">{{ error }}</p>
  </div>
</template>

<style scoped>
.otp-shake {
  animation: otp-shake 0.35s cubic-bezier(0.36, 0.07, 0.19, 0.97);
}
@keyframes otp-shake {
  10%,
  90% {
    transform: translateX(-1px);
  }
  20%,
  80% {
    transform: translateX(2px);
  }
  30%,
  50%,
  70% {
    transform: translateX(-4px);
  }
  40%,
  60% {
    transform: translateX(4px);
  }
}
</style>
