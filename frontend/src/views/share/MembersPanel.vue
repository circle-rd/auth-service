<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import { listMembers, type OwnerMember } from '@/api/resources';

const props = defineProps<{ appId: string }>();

const { t } = useI18n();
const toast = useToast();

const members = ref<OwnerMember[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    const res = await listMembers(props.appId);
    members.value = res.members;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

watch(() => props.appId, () => void load());
onMounted(() => void load());
</script>

<template>
  <div class="space-y-4">
    <p class="text-sm text-surface-400">{{ t('share.members.hint') }}</p>

    <div v-if="loading" class="h-40 rounded-2xl bg-surface-800/40 animate-pulse" />

    <EmptyState
      v-else-if="members.length === 0"
      :title="t('share.members.empty')"
      :message="t('share.members.emptyHint')"
    />

    <div v-else class="rounded-2xl border border-surface-700/40 overflow-x-auto bg-surface-900/40">
      <table class="w-full text-sm">
        <thead class="bg-surface-800/50 text-surface-400">
          <tr>
            <th class="text-left font-medium px-4 py-3">{{ t('share.members.name') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('share.members.email') }}</th>
            <th class="text-left font-medium px-4 py-3 hidden md:table-cell">{{ t('share.members.roles') }}</th>
            <th class="text-left font-medium px-4 py-3">{{ t('common.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="member in members" :key="member.userId" class="border-t border-surface-800/60">
            <td class="px-4 py-3 font-medium text-surface-200">{{ member.name || '—' }}</td>
            <td class="px-4 py-3 text-surface-400">{{ member.email }}</td>
            <td class="px-4 py-3 hidden md:table-cell">
              <div class="flex flex-wrap gap-1">
                <BaseBadge v-for="role in member.roles" :key="role" variant="neutral">{{ role }}</BaseBadge>
                <span v-if="member.roles.length === 0" class="text-xs text-surface-500">{{ t('common.none') }}</span>
              </div>
            </td>
            <td class="px-4 py-3">
              <BaseBadge :variant="member.isActive ? 'success' : 'neutral'" dot>
                {{ member.isActive ? t('common.active') : t('common.inactive') }}
              </BaseBadge>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
