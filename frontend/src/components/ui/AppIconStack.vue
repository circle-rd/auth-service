<script setup lang="ts">
import { computed, ref } from 'vue';
import { AppWindow } from 'lucide-vue-next';
import type { UserAppSummary } from '@/types';

const props = withDefaults(defineProps<{
  apps: UserAppSummary[];
  /** Maximum number of icons rendered inline before being collapsed into a counter. */
  max?: number;
  /** Size of each icon avatar in pixels. */
  size?: number;
}>(), {
  max: 3,
  size: 22,
});

const visible = computed(() => props.apps.slice(0, props.max));
const overflow = computed(() => Math.max(0, props.apps.length - props.max));
const open = ref(false);

function close() { open.value = false; }
</script>

<template>
  <div v-if="apps.length === 0" class="text-xs text-surface-600">—</div>
  <div v-else class="relative inline-flex items-center">
    <button
      type="button"
      class="inline-flex items-center"
      @click.stop="open = !open"
    >
      <span
        v-for="(app, idx) in visible"
        :key="app.id"
        :style="{
          width: `${size}px`,
          height: `${size}px`,
          marginLeft: idx === 0 ? '0' : '-6px',
          zIndex: visible.length - idx,
        }"
        class="inline-flex items-center justify-center rounded-full bg-surface-800 border border-surface-700/60 ring-1 ring-surface-900 overflow-hidden text-surface-300"
        :title="app.name"
      >
        <img v-if="app.icon" :src="app.icon" :alt="app.name" class="w-full h-full object-cover" />
        <AppWindow v-else class="w-3 h-3" />
      </span>
      <span
        v-if="overflow > 0"
        :style="{ height: `${size}px`, marginLeft: '-6px' }"
        class="inline-flex items-center justify-center px-1.5 rounded-full bg-surface-800 border border-surface-700/60 ring-1 ring-surface-900 text-[10px] font-medium text-surface-400"
      >
        +{{ overflow }}
      </span>
    </button>

    <div
      v-if="open"
      v-click-outside="close"
      class="absolute z-30 top-full left-0 mt-1 w-56 bg-surface-800 border border-surface-700/50 rounded-xl shadow-xl py-1"
    >
      <div
        v-for="app in apps"
        :key="app.id"
        class="flex items-center gap-2 px-3 py-2 text-sm text-surface-300 hover:bg-surface-700/40"
      >
        <span class="w-5 h-5 rounded-md bg-surface-700/60 inline-flex items-center justify-center overflow-hidden">
          <img v-if="app.icon" :src="app.icon" :alt="app.name" class="w-full h-full object-cover" />
          <AppWindow v-else class="w-3 h-3 text-surface-400" />
        </span>
        <span class="truncate">{{ app.name }}</span>
      </div>
    </div>
  </div>
</template>
