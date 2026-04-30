<script setup lang="ts">
import { ref } from 'vue';
import { Copy, Check } from 'lucide-vue-next';

defineProps<{
  value: string;
  label?: string;
  masked?: boolean;
}>();

const copied = ref(false);

async function copy(val: string) {
  await navigator.clipboard.writeText(val);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}
</script>

<template>
  <div class="space-y-1.5">
    <label v-if="label" class="block text-xs font-medium text-surface-400 uppercase tracking-wide">{{ label }}</label>
    <div class="flex items-center gap-2 bg-surface-800/60 border border-surface-700 rounded-lg px-3 py-2">
      <code class="flex-1 text-sm font-mono text-surface-300 truncate">
        {{ masked ? '•'.repeat(Math.min(value.length, 32)) : value }}
      </code>
      <button
        @click="copy(value)"
        class="shrink-0 p-1 rounded text-surface-500 hover:text-surface-300 transition-colors"
      >
        <Check v-if="copied" class="w-4 h-4 text-emerald-400" />
        <Copy v-else class="w-4 h-4" />
      </button>
    </div>
  </div>
</template>
