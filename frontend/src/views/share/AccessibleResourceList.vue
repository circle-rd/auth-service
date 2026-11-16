<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import SchemeIcon from '@/components/ui/SchemeIcon.vue';
import type { AccessibleResource } from '@/api/resources';

defineProps<{
  resources: AccessibleResource[];
  icon: string | null;
}>();

const { t } = useI18n();

function accessLabel(item: AccessibleResource): string {
  if (item.accessKind === 'owner') return t('share.catalogue.accessOwner');
  if (item.accessKind === 'admin') return t('share.catalogue.accessAdmin');
  return t(`share.subjectTypes.${item.grantSubjectType ?? 'user'}`);
}
</script>

<template>
  <EmptyState
    v-if="resources.length === 0"
    :title="t('share.catalogue.type.sharedEmpty')"
    :message="t('share.catalogue.type.sharedEmptyHint')"
  />
  <ul v-else class="space-y-2" data-testid="accessible-resources">
    <li
      v-for="item in resources"
      :key="item.resourceId"
      data-testid="catalogue-item"
      class="flex items-center gap-4 rounded-2xl border border-surface-700/40 bg-surface-900/40 px-4 py-3"
    >
      <SchemeIcon :icon="icon" :scheme="item.scheme" size="sm" />
      <div class="min-w-0 flex-1">
        <p class="font-medium text-surface-200 truncate">{{ item.displayName }}</p>
        <p class="font-mono text-xs text-surface-500 truncate">{{ item.resourceUri }}</p>
      </div>
      <BaseBadge variant="success" class="shrink-0">{{ accessLabel(item) }}</BaseBadge>
    </li>
  </ul>
</template>
