<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import {
  LayoutDashboard, Users, Building2, AppWindow, Settings, User, Shield, ChevronRight,
} from 'lucide-vue-next';

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();

const navItems = computed(() => [
  { name: t('nav.dashboard'), to: '/dashboard', icon: LayoutDashboard, adminOnly: true },
  { name: t('nav.users'), to: '/users', icon: Users, adminOnly: true },
  { name: t('nav.organizations'), to: '/organizations', icon: Building2, adminOnly: true },
  { name: t('nav.applications'), to: '/applications', icon: AppWindow, adminOnly: true },
  { name: t('nav.configuration'), to: '/configuration', icon: Settings, adminOnly: true },
  { name: t('nav.profile'), to: '/profile', icon: User, adminOnly: false },
]);

const visibleItems = computed(() =>
  navItems.value.filter(item => !item.adminOnly || auth.isAdmin())
);

function isActive(to: string) {
  return route.path === to || (to !== '/' && route.path.startsWith(to));
}
</script>

<template>
  <aside class="w-64 shrink-0 h-full flex flex-col bg-surface-950/60 backdrop-blur-xl border-r border-surface-800/50">
    <div class="px-5 py-6 flex items-center gap-3 border-b border-surface-800/40">
      <div class="w-8 h-8 rounded-lg bg-primary-600 flex items-center justify-center shadow-lg shadow-primary-900/40">
        <Shield class="w-4 h-4 text-white" />
      </div>
      <div>
        <p class="text-sm font-semibold text-surface-100">Auth Service</p>
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

    <div v-if="auth.user" class="px-3 pb-4 pt-3 border-t border-surface-800/40">
      <RouterLink to="/profile" class="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-800/60 transition-colors group">
        <UserAvatar :name="auth.user.name" :image="auth.user.image" size="sm" />
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-surface-200 truncate">{{ auth.user.name }}</p>
          <p class="text-xs text-surface-500 truncate">{{ auth.user.email }}</p>
        </div>
      </RouterLink>
    </div>
  </aside>
</template>
