<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ShieldCheck, Key as KeyIcon, ArrowLeft } from '@lucide/vue';
import { useAuthStore } from '@/stores/auth';
import BaseInput from '@/components/ui/BaseInput.vue';
import OtpInput from '@/components/ui/OtpInput.vue';
import BaseButton from '@/components/ui/BaseButton.vue';

const emit = defineEmits<{ verified: [] }>();

const { t } = useI18n();
const auth = useAuthStore();

type Mode = 'totp' | 'backup' | 'passkey';

const hasTotp = computed(() => auth.mfaMethods.includes('totp'));
const hasPasskey = computed(() => auth.mfaMethods.includes('passkey'));
const hasBackup = computed(() => auth.mfaBackupCodesAvailable);
const hasAnyMethod = computed(() => hasTotp.value || hasPasskey.value);

const mode = ref<Mode>(
  hasTotp.value ? 'totp' : hasPasskey.value ? 'passkey' : 'totp',
);
const code = ref('');
const loading = ref(false);
const error = ref('');

const TOTP_LENGTH = 6;

watch([hasTotp, hasPasskey, hasBackup], () => {
  if (mode.value === 'totp' && !hasTotp.value) {
    mode.value = hasPasskey.value ? 'passkey' : 'totp';
  } else if (mode.value === 'backup' && !hasBackup.value) {
    mode.value = hasPasskey.value ? 'passkey' : 'totp';
  } else if (mode.value === 'passkey' && !hasPasskey.value) {
    mode.value = 'totp';
  }
});

const hint = computed(() => {
  if (mode.value === 'passkey') return t('mfa.challenge.passkeyHint');
  if (mode.value === 'backup') return t('mfa.challenge.backupHint');
  return t('mfa.challenge.totpHint');
});

async function handleSubmit() {
  if (mode.value === 'passkey') {
    await handlePasskey();
    return;
  }
  const trimmed = code.value.trim();
  if (!trimmed || loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    if (mode.value === 'totp') {
      await auth.verifyMfaTotp(trimmed);
    } else {
      await auth.verifyMfaBackupCode(trimmed);
    }
    emit('verified');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('mfa.errors.invalidCode');
    code.value = '';
  } finally {
    loading.value = false;
  }
}

async function handlePasskey() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    await auth.verifyMfaPasskey();
    emit('verified');
  } catch (err) {
    if (err instanceof Error && err.name === 'NotAllowedError') {
      error.value = t('mfa.errors.passkeyCancelled');
    } else {
      error.value = err instanceof Error ? err.message : t('mfa.errors.passkeyFailed');
    }
  } finally {
    loading.value = false;
  }
}

function switchMode(next: Mode) {
  mode.value = next;
  code.value = '';
  error.value = '';
}

function cancel() {
  auth.cancelMfa();
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-start gap-3">
      <div class="w-9 h-9 rounded-lg bg-primary-500/10 flex items-center justify-center shrink-0">
        <ShieldCheck class="w-5 h-5 text-primary-400" />
      </div>
      <div>
        <p class="text-sm font-medium text-surface-100">{{ t('mfa.challenge.title') }}</p>
        <p class="text-xs text-surface-500 mt-0.5">{{ hint }}</p>
      </div>
    </div>

    <div
      v-if="!hasAnyMethod"
      class="rounded-lg bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-300"
    >
      {{ t('mfa.challenge.noMethods') }}
      <button
        type="button"
        class="mt-2 block text-surface-400 hover:text-surface-200 underline"
        @click="cancel"
      >
        {{ t('common.cancel') }}
      </button>
    </div>

    <template v-else>
      <OtpInput
        v-if="mode === 'totp'"
        v-model="code"
        :length="TOTP_LENGTH"
        :label="t('mfa.code')"
        :error="error"
        :disabled="loading"
        @complete="handleSubmit"
      />
      <BaseInput
        v-else-if="mode === 'backup'"
        v-model="code"
        :label="t('mfa.backupCodes.label')"
        :placeholder="t('mfa.backupCodes.placeholder')"
        :error="error"
        :disabled="loading"
        autocomplete="one-time-code"
        @keyup.enter="handleSubmit"
      />
      <div v-else class="flex items-start gap-3 rounded-lg bg-surface-800/60 p-3">
        <KeyIcon class="w-5 h-5 text-primary-400 mt-0.5 shrink-0" />
        <p class="text-xs text-surface-400">{{ t('mfa.challenge.passkeyBody') }}</p>
      </div>

      <p v-if="error && mode === 'passkey'" class="text-xs text-red-400">{{ error }}</p>

      <BaseButton
        type="button"
        class="w-full"
        :loading="loading"
        :disabled="loading || (mode === 'totp' ? code.length !== TOTP_LENGTH : mode === 'backup' ? !code : false)"
        size="lg"
        @click="handleSubmit"
      >
        <KeyIcon v-if="mode === 'passkey'" class="w-4 h-4" />
        <ShieldCheck v-else class="w-4 h-4" />
        {{ mode === 'passkey' ? t('mfa.challenge.usePasskeyAction') : t('mfa.challenge.verify') }}
      </BaseButton>

      <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div class="flex flex-wrap items-center gap-3">
          <button
            v-if="mode === 'totp' && hasBackup"
            type="button"
            class="text-surface-400 hover:text-surface-200 inline-flex items-center gap-1"
            @click="switchMode('backup')"
          >
            <KeyIcon class="w-3.5 h-3.5" />
            {{ t('mfa.challenge.useBackup') }}
          </button>
          <button
            v-else-if="mode === 'backup'"
            type="button"
            class="text-surface-400 hover:text-surface-200 inline-flex items-center gap-1"
            @click="switchMode('totp')"
          >
            <ArrowLeft class="w-3.5 h-3.5" />
            {{ t('mfa.challenge.useTotp') }}
          </button>
          <button
            v-if="mode !== 'passkey' && hasPasskey"
            type="button"
            class="text-surface-400 hover:text-surface-200 inline-flex items-center gap-1"
            @click="switchMode('passkey')"
          >
            <KeyIcon class="w-3.5 h-3.5" />
            {{ t('mfa.challenge.usePasskey') }}
          </button>
          <button
            v-else-if="mode === 'passkey' && hasTotp"
            type="button"
            class="text-surface-400 hover:text-surface-200 inline-flex items-center gap-1"
            @click="switchMode('totp')"
          >
            <ArrowLeft class="w-3.5 h-3.5" />
            {{ t('mfa.challenge.useTotp') }}
          </button>
        </div>
        <button
          type="button"
          class="text-surface-500 hover:text-surface-300"
          @click="cancel"
        >
          {{ t('common.cancel') }}
        </button>
      </div>
    </template>
  </div>
</template>