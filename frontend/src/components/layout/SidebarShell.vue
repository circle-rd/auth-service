<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { X } from '@lucide/vue';
import AppLogo from '@/components/branding/AppLogo.vue';
import { useAppBranding } from '@/composables/useAppBranding';
import { useMobileNav } from '@/composables/useMobileNav';

const APP_VERSION = __APP_VERSION__;

defineProps<{ subtitle: string }>();

defineSlots<{
  default(): unknown;
  selector?(props: { collapsed: boolean }): unknown;
}>();

const { t } = useI18n();
const { branding } = useAppBranding();
const { isSidebarOpen, close, isSidebarCollapsed } = useMobileNav();
</script>

<template>
  <aside :class="[
    'fixed md:static inset-y-0 z-40 shrink-0 h-full flex flex-col',
    'bg-surface-950/60 backdrop-blur-xl border-r border-surface-800/50',
    'transition-[left,width] duration-200 ease-in-out',
    isSidebarOpen ? 'left-0' : '-left-full',
    'md:left-0 w-64',
    isSidebarCollapsed ? 'md:w-16' : 'md:w-64',
  ]">
    <button
      @click="close"
      class="md:hidden absolute top-4 right-4 p-1.5 rounded-lg text-surface-400 hover:text-surface-200 hover:bg-surface-800/60 transition-colors z-50"
      :aria-label="t('aria.closeSidebar') || 'Close sidebar'"
    >
      <X class="w-5 h-5" />
    </button>

    <div :class="[
      'py-6 flex items-center border-b border-surface-800/40 transition-all',
      isSidebarCollapsed ? 'md:px-3 md:justify-center px-5 gap-0' : 'px-5 gap-3',
    ]">
      <div v-if="!branding.logoUrl" class="w-8 h-8 rounded-lg bg-primary-600 flex items-center justify-center shadow-lg shadow-primary-900/40 overflow-hidden">
        <AppLogo :size="16" icon-class="text-white" />
      </div>
      <AppLogo v-else :size="32" icon-class="text-white" />
      <div :class="[{ 'md:hidden': isSidebarCollapsed }]">
        <p class="text-sm font-semibold text-surface-100">{{ branding.appName }}</p>
        <p class="text-xs text-surface-500">{{ subtitle }}</p>
      </div>
    </div>

    <slot name="selector" :collapsed="isSidebarCollapsed" />

    <nav class="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
      <slot />
    </nav>

    <p
      :class="['px-5 py-3 text-[11px] text-surface-600 tabular-nums select-text', { 'md:hidden': isSidebarCollapsed }]"
      :title="t('nav.version')"
    >
      v{{ APP_VERSION }}
    </p>
  </aside>
</template>
