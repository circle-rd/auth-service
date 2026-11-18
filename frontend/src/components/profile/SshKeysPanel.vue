<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { KeyRound, Plus, Trash2 } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import { formatDateTime } from '@/views/share/format';
import { listRecipientKeys, revokeRecipientKey, type SshRecipientKey } from '@/api/resources';
import SshKeyFormModal from './SshKeyFormModal.vue';

const { t } = useI18n();
const toast = useToast();

const keys = ref<SshRecipientKey[]>([]);
const loading = ref(true);
const showForm = ref(false);
const pendingRevoke = ref<SshRecipientKey | null>(null);
const revoking = ref(false);

async function load() {
  loading.value = true;
  try {
    keys.value = (await listRecipientKeys()).keys;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.loadError'));
  } finally {
    loading.value = false;
  }
}

async function revoke() {
  const target = pendingRevoke.value;
  if (!target) return;
  revoking.value = true;
  try {
    await revokeRecipientKey(target.id);
    toast.success(t('share.sshKeys.revokedToast'));
    pendingRevoke.value = null;
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    revoking.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-4 sm:p-5 space-y-4" data-testid="ssh-keys-panel">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('share.sshKeys.title') }}</h3>
        <p class="text-xs text-surface-500 mt-1">{{ t('share.sshKeys.hint') }}</p>
      </div>
      <BaseButton size="sm" @click="showForm = true">
        <Plus class="w-3.5 h-3.5" />{{ t('share.sshKeys.add') }}
      </BaseButton>
    </div>

    <div v-if="loading" class="h-24 rounded-2xl bg-surface-800/40 animate-pulse" />
    <EmptyState
      v-else-if="keys.length === 0"
      :title="t('share.sshKeys.empty')"
      :message="t('share.sshKeys.emptyHint')"
    >
      <template #icon><KeyRound class="w-8 h-8 text-surface-500" /></template>
    </EmptyState>
    <ul v-else class="space-y-2">
      <li
        v-for="key in keys"
        :key="key.id"
        class="flex items-center gap-3 rounded-xl border border-surface-700/40 bg-surface-900/40 px-3 py-2.5"
      >
        <span class="w-8 h-8 shrink-0 rounded-lg bg-surface-800 flex items-center justify-center text-surface-400">
          <KeyRound class="w-4 h-4" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-sm text-surface-200 truncate">{{ key.label || t('share.sshKeys.unlabeled') }}</p>
          <p class="font-mono text-[11px] text-surface-500 truncate">{{ key.fingerprint }}</p>
        </div>
        <span class="hidden sm:block text-xs text-surface-500 shrink-0">{{ formatDateTime(key.createdAt) }}</span>
        <button
          type="button"
          class="p-2 rounded-lg text-surface-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          :title="t('share.sshKeys.revoke')"
          :aria-label="t('share.sshKeys.revoke')"
          @click="pendingRevoke = key"
        >
          <Trash2 class="w-4 h-4" />
        </button>
      </li>
    </ul>

    <SshKeyFormModal :open="showForm" @close="showForm = false" @saved="load" />

    <ConfirmDialog
      :open="pendingRevoke !== null"
      :title="t('share.sshKeys.revokeTitle')"
      :message="t('share.sshKeys.revokeMessage', { name: pendingRevoke?.label || t('share.sshKeys.unlabeled') })"
      :confirm-label="t('share.sshKeys.revoke')"
      :loading="revoking"
      @confirm="revoke"
      @cancel="pendingRevoke = null"
    />
  </section>
</template>
