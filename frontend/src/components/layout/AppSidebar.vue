<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import {
  LayoutDashboard, Users, Building2, AppWindow, Wallet, ReceiptText, Settings,
} from '@lucide/vue';
import SidebarShell from './SidebarShell.vue';
import SidebarNavItem from './SidebarNavItem.vue';

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();

const navItems = computed(() => [
  { name: t('nav.dashboard'), to: '/dashboard', icon: LayoutDashboard, adminOnly: true },
  { name: t('nav.users'), to: '/users', icon: Users, adminOnly: true },
  { name: t('nav.organizations'), to: '/organizations', icon: Building2, adminOnly: true },
  { name: t('nav.applications'), to: '/applications', icon: AppWindow, adminOnly: true },
  { name: t('nav.wallets'), to: '/wallets', icon: Wallet, adminOnly: true },
  { name: t('nav.accounting'), to: '/accounting', icon: ReceiptText, adminOnly: true },
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
  <SidebarShell subtitle="Admin Panel">
    <SidebarNavItem
      v-for="item in visibleItems"
      :key="item.to"
      :to="item.to"
      :label="item.name"
      :icon="item.icon"
      :active="isActive(item.to)"
    />
  </SidebarShell>
</template>
