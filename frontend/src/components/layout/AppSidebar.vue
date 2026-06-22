<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import {
  LayoutDashboard, Users, Building2, AppWindow, Settings, ChevronRight, X,
} from 'lucide-vue-next';
import AppLogo from '@/components/branding/AppLogo.vue';
import { useAppBranding } from '@/composables/useAppBranding';
import { useMobileNav } from '@/composables/useMobileNav';

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const { branding } = useAppBranding();
const { isSidebarOpen, close } = useMobileNav();

const navItems = computed(() => [
  { name: t('nav.dashboard'), to: '/dashboard', icon: LayoutDashboard, adminOnly: true },
  { name: t('nav.users'), to: '/users', icon: Users, adminOnly: true },
  { name: t('nav.organizations'), to: '/organizations', icon: Building2, adminOnly: true },
  { name: t('nav.applications'), to: '/applications', icon: AppWindow, adminOnly: true },
  { name: t('nav.configuration'), to: '/configuration', icon: Settings, adminOnly: true },
]);

const visibleItems = computed(() =>
  navItems.value.filter(item => !item.adminOnly || auth.isAdmin())
);

function isActive(to: string) {
  return route.path === to || (to !== '/' && route.path.startsWith(to));
}
</script>

<template>
  <aside :class="[
    'fixed md:static inset-y-0 left-0 z-40 w-64 shrink-0 h-full flex flex-col',
    'bg-surface-950/60 backdrop-blur-xl border-r border-surface-800/50',
    'transform transition-transform duration-200 ease-in-out',
    isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
  ]">
    <!-- Close button (mobile only) -->
    <button
      @click="close"
      class="md:hidden absolute top-4 right-4 p-1.5 rounded-lg text-surface-400 hover:text-surface-200 hover:bg-surface-800/60 transition-colors z-50"
      :aria-label="t('aria.closeSidebar') || 'Close sidebar'"
    >
      <X class="w-5 h-5" />
    </button>

    <div class="px-5 py-6 flex items-center gap-3 border-b border-surface-800/40">
      <div v-if="!branding.logoUrl" class="w-8 h-8 rounded-lg bg-primary-600 flex items-center justify-center shadow-lg shadow-primary-900/40 overflow-hidden">
        <AppLogo :size="16" icon-class="text-white" />
      </div>
      <AppLogo v-else :size="32" icon-class="text-white" />
      <div>
        <p class="text-sm font-semibold text-surface-100">{{ branding.appName }}</p>
        <p class="text-xs text-surface-500">Admin Panel</p>
      </div>
    </div>

    <nav class="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
      <RouterLink
        v-for="item in visibleItems"
        :key="item.to"
        :to="item.to"
        :class="[
          'group flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150',
          isActive(item.to)
            ? 'bg-primary-600/15 text-primary-300 shadow-sm'
            : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/60',
        ]"
      >
        <component
          :is="item.icon"
          :class="['w-4 h-4 shrink-0 transition-colors', isActive(item.to) ? 'text-primary-400' : 'text-surface-500 group-hover:text-surface-300']"
        />
        <span class="flex-1">{{ item.name }}</span>
        <ChevronRight
          v-if="isActive(item.to)"
          class="w-3.5 h-3.5 text-primary-500"
        />
      </RouterLink>
    </nav>
  </aside>
</template>
