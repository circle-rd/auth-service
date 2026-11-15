<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { KeyRound, Plus, Trash2 } from '@lucide/vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useToast } from '@/composables/useToast';
import {
  listRecipientKeys,
  registerRecipientKey,
  revokeRecipientKey,
  type SshRecipientKey,
} from '@/api/resources';

const { t } = useI18n();
const toast = useToast();

const keys = ref<SshRecipientKey[]>([]);
const loading = ref(true);
const saving = ref(false);
const showForm = ref(false);
const form = reactive({ publicKey: '', label: '' });

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

function openCreate() {
  form.publicKey = '';
  form.label = '';
  showForm.value = true;
}

async function save() {
  saving.value = true;
  try {
    await registerRecipientKey(form.publicKey.trim(), form.label.trim() || undefined);
    toast.success(t('share.sshKeys.added'));
    showForm.value = false;
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  } finally {
    saving.value = false;
  }
}

async function revoke(key: SshRecipientKey) {
  try {
    await revokeRecipientKey(key.id);
    toast.success(t('share.sshKeys.revokedToast'));
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('share.saveError'));
  }
}

onMounted(() => void load());
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-2 text-sm font-semibold text-surface-200">
          <KeyRound class="w-4 h-4" />{{ t('share.sshKeys.title') }}
        </h2>
        <p class="text-xs text-surface-500">{{ t('share.sshKeys.hint') }}</p>
      </div>
      <BaseButton size="sm" @click="openCreate">
        <Plus class="w-3.5 h-3.5" />{{ t('share.sshKeys.add') }}
      </BaseButton>
    </div>

    <div v-if="loading" class="h-24 rounded-2xl bg-surface-800/40 animate-pulse" />
    <EmptyState
      v-else-if="keys.length === 0"
      :title="t('share.sshKeys.empty')"
      :message="t('share.sshKeys.emptyHint')"
    />
    <div v-else class="space-y-2">
      <div
        v-for="key in keys"
        :key="key.id"
        class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-surface-700/40 bg-surface-900/40 p-3"
      >
        <div class="min-w-0">
          <p class="text-sm text-surface-200">{{ key.label || t('share.sshKeys.unlabeled') }}</p>
          <p class="font-mono text-[11px] text-surface-500 break-all">{{ key.fingerprint }}</p>
        </div>
        <BaseButton variant="ghost" size="sm" @click="revoke(key)">
          <Trash2 class="w-3.5 h-3.5" />{{ t('share.sshKeys.revoke') }}
        </BaseButton>
      </div>
    </div>

    <BaseModal :open="showForm" :title="t('share.sshKeys.addTitle')" size="md" @close="showForm = false">
      <div class="space-y-3">
        <BaseInput v-model="form.label" :label="t('share.sshKeys.label')" />
        <BaseInput
          v-model="form.publicKey"
          type="textarea"
          :label="t('share.sshKeys.publicKey')"
          :hint="t('share.sshKeys.publicKeyHint')"
          required
        />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showForm = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="saving" :disabled="!form.publicKey.trim()" @click="save">
          {{ t('share.sshKeys.add') }}
        </BaseButton>
      </template>
    </BaseModal>
  </section>
</template>
