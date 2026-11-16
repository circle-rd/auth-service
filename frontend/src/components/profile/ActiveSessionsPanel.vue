<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Monitor } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import { parseUserAgent } from '@/composables/useUserAgent';
import type { Session } from '@/types';

defineProps<{
  sessions: Session[];
  loading: boolean;
  currentSessionId: string;
  revokeOthersLoading: boolean;
}>();

const emit = defineEmits<{
  revoke: [session: Session];
  revokeOthers: [];
}>();

const { t } = useI18n();

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}
</script>

<template>
  <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
    <div class="px-5 py-4 border-b border-surface-700/40 flex items-center justify-between gap-3">
      <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.activeSessions') }}</h3>
      <BaseButton
        v-if="sessions.length > 1"
        variant="ghost"
        size="sm"
        :loading="revokeOthersLoading"
        @click="emit('revokeOthers')"
      >
        {{ t('profile.revokeOtherSessions') }}
      </BaseButton>
    </div>
    <div v-if="loading" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.loading') }}</div>
    <div v-else-if="sessions.length === 0" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.noData') }}</div>
    <div v-else class="divide-y divide-surface-800/40">
      <div v-for="session in sessions" :key="session.id" class="px-4 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
        <div class="w-8 h-8 rounded-lg bg-surface-800 flex items-center justify-center shrink-0">
          <Monitor class="w-4 h-4 text-surface-400" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <p class="text-sm text-surface-200">{{ parseUserAgent(session.userAgent).browser }} on {{ parseUserAgent(session.userAgent).os }}</p>
            <BaseBadge v-if="session.id === currentSessionId" variant="success" size="sm">{{ t('profile.current') }}</BaseBadge>
          </div>
          <p class="text-xs text-surface-500 mt-0.5">{{ session.ipAddress ?? '—' }} · {{ formatDate(session.createdAt) }}</p>
        </div>
        <BaseButton v-if="session.id !== currentSessionId" variant="ghost" size="sm" @click="emit('revoke', session)">{{ t('profile.revoke') }}</BaseButton>
      </div>
    </div>
  </div>
</template>
