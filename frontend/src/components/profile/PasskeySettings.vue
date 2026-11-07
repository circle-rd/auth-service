<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser';
import {
  AlertTriangle,
  CheckCircle,
  Key as KeyIcon,
  Pencil,
  Plus,
  Trash2,
} from '@lucide/vue';
import {
  deletePasskey,
  listPasskeys,
  registerPasskey,
  renamePasskey,
} from '@/api/passkeys';
import { ApiError } from '@/api/client';
import type { PasskeySummary } from '@/types';
import { useToast } from '@/composables/useToast';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';

const emit = defineEmits<{ changed: [] }>();

const { t } = useI18n();
const toast = useToast();

const passkeys = ref<PasskeySummary[]>([]);
const loading = ref(false);
const loadError = ref('');

const showAdd = ref(false);
const showRename = ref(false);
const showDelete = ref(false);
const selected = ref<PasskeySummary | null>(null);
const name = ref('');
const actionLoading = ref(false);
const actionError = ref('');

const webAuthnSupported = browserSupportsWebAuthn();
const secureContext = window.isSecureContext;

const canAdd = computed(() => webAuthnSupported && secureContext);
const addDisabledReason = computed(() => {
  if (!webAuthnSupported) return t('mfa.passkeys.errors.unsupported');
  if (!secureContext) return t('mfa.passkeys.errors.insecureContext');
  return '';
});

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const known: Record<string, string> = {
      SESSION_NOT_FRESH: t('mfa.passkeys.errors.sessionNotFresh'),
      MFA_009: t('mfa.passkeys.errors.lastFactorRequired'),
      MFA_010: t('mfa.passkeys.errors.lastAuthenticationMethod'),
      MFA_003: t('mfa.passkeys.errors.challengeExpired'),
      MFA_011: t('mfa.passkeys.errors.passwordRequired'),
    };
    return known[err.code] ?? err.message;
  }
  if (err instanceof Error && err.name === 'NotAllowedError') {
    return t('mfa.passkeys.errors.cancelled');
  }
  return err instanceof Error ? err.message : fallback;
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    passkeys.value = await listPasskeys();
  } catch (err) {
    loadError.value = errorMessage(err, t('mfa.passkeys.errors.loadFailed'));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function openAdd(): void {
  name.value = '';
  actionError.value = '';
  showAdd.value = true;
}

async function handleAdd(): Promise<void> {
  if (!canAdd.value || actionLoading.value) return;
  actionLoading.value = true;
  actionError.value = '';
  try {
    await registerPasskey(name.value.trim() || undefined);
    await load();
    emit('changed');
    toast.success(t('mfa.passkeys.addedToast'));
    showAdd.value = false;
  } catch (err) {
    actionError.value = errorMessage(err, t('mfa.passkeys.errors.addFailed'));
  } finally {
    actionLoading.value = false;
  }
}

function openRename(passkey: PasskeySummary): void {
  selected.value = passkey;
  name.value = passkey.name ?? '';
  actionError.value = '';
  showRename.value = true;
}

async function handleRename(): Promise<void> {
  const target = selected.value;
  const nextName = name.value.trim();
  if (!target || !nextName || actionLoading.value) return;
  actionLoading.value = true;
  actionError.value = '';
  try {
    await renamePasskey(target.id, nextName);
    await load();
    emit('changed');
    toast.success(t('mfa.passkeys.renamedToast'));
    showRename.value = false;
  } catch (err) {
    actionError.value = errorMessage(err, t('mfa.passkeys.errors.renameFailed'));
  } finally {
    actionLoading.value = false;
  }
}

function openDelete(passkey: PasskeySummary): void {
  selected.value = passkey;
  actionError.value = '';
  showDelete.value = true;
}

async function handleDelete(): Promise<void> {
  const target = selected.value;
  if (!target || actionLoading.value) return;
  actionLoading.value = true;
  actionError.value = '';
  try {
    await deletePasskey(target.id);
    await load();
    emit('changed');
    toast.success(t('mfa.passkeys.deletedToast'));
    showDelete.value = false;
  } catch (err) {
    actionError.value = errorMessage(err, t('mfa.passkeys.errors.deleteFailed'));
  } finally {
    actionLoading.value = false;
  }
}

function displayName(passkey: PasskeySummary): string {
  return passkey.name?.trim() || t('mfa.passkeys.unnamed');
}

function deviceLabel(passkey: PasskeySummary): string {
  return passkey.deviceType === 'multiDevice'
    ? t('mfa.passkeys.syncedDevice')
    : t('mfa.passkeys.thisDevice');
}

function formatDate(value: string | null): string {
  if (!value) return t('mfa.passkeys.unknownDate');
  return new Date(value).toLocaleDateString(undefined, {
    dateStyle: 'medium',
  });
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <p class="text-sm font-medium text-surface-200">{{ t('mfa.passkeys.title') }}</p>
        <BaseBadge variant="neutral" size="sm">{{ passkeys.length }}</BaseBadge>
      </div>
      <BaseButton
        variant="primary"
        size="sm"
        :disabled="!canAdd"
        @click="openAdd"
      >
        <Plus class="w-4 h-4" />
        {{ t('mfa.passkeys.add') }}
      </BaseButton>
    </div>

    <p class="text-xs text-surface-500">{{ t('mfa.passkeys.description') }}</p>

    <p v-if="addDisabledReason" class="text-xs text-amber-400">{{ addDisabledReason }}</p>

    <div
      v-if="loadError"
      class="rounded-lg bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-300"
    >
      {{ loadError }}
    </div>

    <div v-if="loading" class="text-xs text-surface-500">{{ t('common.loading') }}</div>

    <div
      v-else-if="!loadError && passkeys.length === 0"
      class="rounded-lg border border-dashed border-surface-700/60 p-4 text-center"
    >
      <KeyIcon class="w-6 h-6 text-surface-500 mx-auto mb-2" />
      <p class="text-xs text-surface-500">{{ t('mfa.passkeys.empty') }}</p>
    </div>

    <ul v-else class="space-y-2">
      <li
        v-for="passkey in passkeys"
        :key="passkey.id"
        class="flex items-center justify-between gap-3 rounded-lg bg-surface-800/40 px-3 py-2.5"
      >
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center shrink-0">
            <KeyIcon class="w-4 h-4 text-primary-400" />
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2 min-w-0">
              <p class="text-sm text-surface-200 truncate">{{ displayName(passkey) }}</p>
              <BaseBadge v-if="passkey.backedUp" variant="success" size="sm" dot>
                {{ t('mfa.passkeys.synced') }}
              </BaseBadge>
            </div>
            <p class="text-[11px] text-surface-500 mt-0.5">
              {{ deviceLabel(passkey) }} · {{ formatDate(passkey.createdAt) }}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button
            type="button"
            class="p-1.5 rounded-lg text-surface-400 hover:text-surface-200 hover:bg-surface-700/50"
            :title="t('mfa.passkeys.rename')"
            @click="openRename(passkey)"
          >
            <Pencil class="w-4 h-4" />
          </button>
          <button
            type="button"
            class="p-1.5 rounded-lg text-surface-400 hover:text-red-400 hover:bg-red-500/10"
            :title="t('mfa.passkeys.delete')"
            @click="openDelete(passkey)"
          >
            <Trash2 class="w-4 h-4" />
          </button>
        </div>
      </li>
    </ul>

    <BaseModal
      :open="showAdd"
      :title="t('mfa.passkeys.addTitle')"
      size="sm"
      @close="showAdd = false"
    >
      <div class="space-y-4">
        <p class="text-xs text-surface-400">{{ t('mfa.passkeys.addIntro') }}</p>
        <BaseInput
          v-model="name"
          :label="t('mfa.passkeys.nameLabel')"
          :placeholder="t('mfa.passkeys.namePlaceholder')"
          :error="actionError"
          @keyup.enter="handleAdd"
        />
        <div class="flex items-start gap-2 rounded-lg bg-surface-800/60 p-3">
          <CheckCircle class="w-4 h-4 text-primary-400 mt-0.5 shrink-0" />
          <p class="text-[11px] text-surface-400">{{ t('mfa.passkeys.addHint') }}</p>
        </div>
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showAdd = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton variant="primary" :loading="actionLoading" @click="handleAdd">
          <KeyIcon class="w-4 h-4" />
          {{ t('mfa.passkeys.addAction') }}
        </BaseButton>
      </template>
    </BaseModal>

    <BaseModal
      :open="showRename"
      :title="t('mfa.passkeys.renameTitle')"
      size="sm"
      @close="showRename = false"
    >
      <BaseInput
        v-model="name"
        :label="t('mfa.passkeys.nameLabel')"
        :placeholder="t('mfa.passkeys.namePlaceholder')"
        :error="actionError"
        @keyup.enter="handleRename"
      />
      <template #footer>
        <BaseButton variant="ghost" @click="showRename = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton
          variant="primary"
          :loading="actionLoading"
          :disabled="!name.trim()"
          @click="handleRename"
        >
          {{ t('common.save') }}
        </BaseButton>
      </template>
    </BaseModal>

    <BaseModal
      :open="showDelete"
      :title="t('mfa.passkeys.deleteTitle')"
      size="sm"
      @close="showDelete = false"
    >
      <div class="space-y-3">
        <div class="flex items-start gap-3 rounded-lg bg-amber-500/10 border border-amber-500/30 p-3">
          <AlertTriangle class="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <p class="text-xs text-amber-200">
            {{ t('mfa.passkeys.deleteWarning', { name: selected ? displayName(selected) : '' }) }}
          </p>
        </div>
        <p v-if="actionError" class="text-xs text-red-400">{{ actionError }}</p>
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showDelete = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton variant="danger" :loading="actionLoading" @click="handleDelete">
          <Trash2 class="w-4 h-4" />
          {{ t('mfa.passkeys.deleteAction') }}
        </BaseButton>
      </template>
    </BaseModal>
  </div>
</template>