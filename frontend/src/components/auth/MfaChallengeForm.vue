<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ShieldCheck, Key as KeyIcon, ArrowLeft } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseButton from '@/components/ui/BaseButton.vue';

const emit = defineEmits<{ verified: [] }>();

const { t } = useI18n();
const auth = useAuthStore();

type Mode = 'totp' | 'backup';

const mode = ref<Mode>('totp');
const code = ref('');
const loading = ref(false);
const error = ref('');

async function handleSubmit() {
  const trimmed = code.value.trim();
  if (!trimmed) return;
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
        <p class="text-xs text-surface-500 mt-0.5">
          {{ mode === 'totp' ? t('mfa.challenge.totpHint') : t('mfa.challenge.backupHint') }}
        </p>
      </div>
    </div>

    <BaseInput
      v-model="code"
      :label="mode === 'totp' ? t('mfa.code') : t('mfa.backupCodes.label')"
      :placeholder="mode === 'totp' ? t('mfa.codePlaceholder') : t('mfa.backupCodes.placeholder')"
      :error="error"
      :inputmode="mode === 'totp' ? 'numeric' : 'text'"
      autocomplete="one-time-code"
      @keyup.enter="handleSubmit"
    />

    <BaseButton type="button" class="w-full" :loading="loading" :disabled="!code" size="lg" @click="handleSubmit">
      <ShieldCheck class="w-4 h-4" />
      {{ t('mfa.challenge.verify') }}
    </BaseButton>

    <div class="flex items-center justify-between text-xs">
      <button
        v-if="mode === 'totp'"
        type="button"
        class="text-surface-400 hover:text-surface-200 inline-flex items-center gap-1"
        @click="switchMode('backup')"
      >
        <KeyIcon class="w-3.5 h-3.5" />
        {{ t('mfa.challenge.useBackup') }}
      </button>
      <button
        v-else
        type="button"
        class="text-surface-400 hover:text-surface-200 inline-flex items-center gap-1"
        @click="switchMode('totp')"
      >
        <ArrowLeft class="w-3.5 h-3.5" />
        {{ t('mfa.challenge.useTotp') }}
      </button>
      <button
        type="button"
        class="text-surface-500 hover:text-surface-300"
        @click="cancel"
      >
        {{ t('common.cancel') }}
      </button>
    </div>
  </div>
</template>
