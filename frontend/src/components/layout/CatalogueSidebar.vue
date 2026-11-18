<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { LayoutDashboard, Settings2 } from '@lucide/vue';
import SidebarShell from './SidebarShell.vue';
import SidebarNavItem from './SidebarNavItem.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import { useCatalogueStore } from '@/stores/catalogue';
import { useMobileNav } from '@/composables/useMobileNav';
import type { SelectOption } from '@/types/select';

const props = defineProps<{ appId: string | null }>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const store = useCatalogueStore();
const { isSidebarCollapsed, toggleCollapsed } = useMobileNav();

const app = computed(() => (props.appId ? store.byId.get(props.appId) ?? null : null));
const overview = computed(() => (props.appId ? store.overviews[props.appId] ?? null : null));

const appOptions = computed<SelectOption[]>(() =>
  store.apps.map((entry) => ({
    value: entry.id,
    label: entry.name,
    description: entry.description ?? entry.slug,
    avatar: { name: entry.name, image: entry.icon },
  })),
);

// A resource appears once even when it is both mine and shared with me.
function countFor(scheme: string): number {
  const ids = new Set<string>();
  for (const resource of overview.value?.mine ?? []) {
    if (resource.scheme === scheme) ids.add(resource.id);
  }
  for (const resource of overview.value?.accessible ?? []) {
    if (resource.scheme === scheme) ids.add(resource.resourceId);
  }
  return ids.size;
}

function switchApp(nextId: string) {
  if (nextId === props.appId) return;
  const keepsManage = route.name === 'catalogue-manage' && store.byId.get(nextId)?.owner;
  void router.push({
    name: keepsManage ? 'catalogue-manage' : 'catalogue-dashboard',
    params: { appId: nextId },
  });
}
</script>

<template>
  <SidebarShell :subtitle="t('share.catalogue.title')">
    <template #selector="{ collapsed }">
      <div class="px-3 pt-4">
        <button
          v-if="collapsed"
          type="button"
          class="hidden md:flex w-full justify-center rounded-lg p-1.5 hover:bg-surface-800/60 transition-colors"
          :title="app?.name ?? t('share.catalogue.nav.application')"
          :aria-label="t('share.catalogue.nav.application')"
          @click="toggleCollapsed"
        >
          <UserAvatar v-if="app" :name="app.name" :image="app.icon" size="sm" />
        </button>
        <BaseSelect
          :class="{ 'md:hidden': collapsed }"
          :label="t('share.catalogue.nav.application')"
          :model-value="appId ?? ''"
          :options="appOptions"
          :placeholder="t('share.catalogue.nav.noApplication')"
          show-selected-description
          @update:model-value="switchApp"
        />
      </div>
    </template>

    <template v-if="app">
      <SidebarNavItem
        :to="{ name: 'catalogue-dashboard', params: { appId: app.id } }"
        :label="t('share.catalogue.nav.dashboard')"
        :icon="LayoutDashboard"
        :active="route.name === 'catalogue-dashboard'"
      />

      <p
        v-if="overview && overview.schemes.length > 0"
        :class="['px-3 pt-5 pb-1 text-[11px] font-medium uppercase tracking-wider text-surface-600', { 'md:hidden': isSidebarCollapsed }]"
      >
        {{ t('share.catalogue.nav.types') }}
      </p>
      <SidebarNavItem
        v-for="scheme in overview?.schemes ?? []"
        :key="scheme.scheme"
        :to="{ name: 'catalogue-type', params: { appId: app.id, scheme: scheme.scheme } }"
        :label="scheme.displayName"
        :scheme="{ name: scheme.scheme, icon: scheme.icon }"
        :badge="countFor(scheme.scheme)"
        :active="route.name === 'catalogue-type' && route.params.scheme === scheme.scheme"
      />

      <div v-if="app.owner" class="mt-4 pt-4 border-t border-surface-800/40">
        <SidebarNavItem
          :to="{ name: 'catalogue-manage', params: { appId: app.id } }"
          :label="t('share.catalogue.nav.manage')"
          :icon="Settings2"
          :active="route.name === 'catalogue-manage'"
        />
      </div>
    </template>
  </SidebarShell>
</template>
