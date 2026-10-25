<script setup lang="ts">
const props = defineProps<{
  label: string;
  addLabel: string;
  placeholder: string;
  hint?: string;
  // Entries whose value is listed here are managed elsewhere and not shown.
  hidden?: string[];
}>();

const model = defineModel<string[]>({ required: true });

const inputClass =
  'flex-1 px-3 py-2 text-sm bg-surface-800/80 border border-surface-700/60 rounded-md text-surface-100 placeholder:text-surface-600 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500/60 transition-all';

function isShown(value: string): boolean {
  return !props.hidden?.includes(value);
}

function update(i: number, value: string) {
  model.value = model.value.map((v, idx) => (idx === i ? value : v));
}

function remove(i: number) {
  model.value = model.value.filter((_, idx) => idx !== i);
}

function add() {
  model.value = [...model.value, ''];
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-2">
      <p class="text-xs font-medium text-surface-500 uppercase tracking-wider">{{ label }}</p>
      <button
        type="button"
        @click="add"
        class="text-xs text-primary-400 hover:text-primary-300 transition-colors font-medium"
      >
        + {{ addLabel }}
      </button>
    </div>
    <p v-if="hint" class="text-xs text-surface-500 mb-2">{{ hint }}</p>
    <div class="space-y-2">
      <template v-for="(value, i) in model" :key="i">
        <div v-if="isShown(value)" class="flex gap-2">
          <input
            :value="value"
            :placeholder="placeholder"
            :class="inputClass"
            @input="update(i, ($event.target as HTMLInputElement).value)"
          />
          <button
            type="button"
            @click="remove(i)"
            class="px-2 text-surface-600 hover:text-red-400 transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
