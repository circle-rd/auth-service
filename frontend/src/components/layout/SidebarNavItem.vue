<script setup lang="ts">
import type { Component } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { RouterLink } from 'vue-router';
import { ChevronRight } from '@lucide/vue';
import SchemeIcon from '@/components/ui/SchemeIcon.vue';
import { useMobileNav } from '@/composables/useMobileNav';

defineProps<{
  to: RouteLocationRaw;
  label: string;
  active: boolean;
  icon?: Component;
  // Resource-type entries render the type icon instead of a lucide glyph.
  scheme?: { name: string; icon: string | null };
  badge?: number;
}>();

const { close, isSidebarCollapsed } = useMobileNav();

function handleClick() {
  if (window.innerWidth < 768) close();
}
</script>

<template>
  <RouterLink
    :to="to"
    :aria-current="active ? 'page' : undefined"
    @click="handleClick"
    :class="[
      'group relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150',
      isSidebarCollapsed ? 'md:justify-center md:px-2' : '',
      active
        ? 'bg-primary-600/15 text-primary-300 shadow-sm'
        : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/60',
    ]"
  >
    <SchemeIcon v-if="scheme" :icon="scheme.icon" :scheme="scheme.name" size="sm" />
    <component
      :is="icon"
      v-else-if="icon"
      :class="['w-4 h-4 shrink-0 transition-colors', active ? 'text-primary-400' : 'text-surface-500 group-hover:text-surface-300']"
    />
    <span :class="['flex-1 truncate', { 'md:hidden': isSidebarCollapsed }]">{{ label }}</span>
    <span
      v-if="badge !== undefined"
      :class="['text-xs tabular-nums text-surface-500', { 'md:hidden': isSidebarCollapsed }]"
    >
      {{ badge }}
    </span>
    <ChevronRight
      v-if="active && badge === undefined"
      :class="['w-3.5 h-3.5 text-primary-500', { 'md:hidden': isSidebarCollapsed }]"
    />

    <span
      v-if="isSidebarCollapsed"
      class="hidden md:block pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-3 px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap bg-surface-900 text-surface-100 border border-surface-700/60 shadow-lg opacity-0 scale-95 transition-all duration-150 group-hover:opacity-100 group-hover:scale-100"
    >
      {{ label }}
    </span>
  </RouterLink>
</template>
