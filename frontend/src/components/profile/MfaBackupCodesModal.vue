<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RefreshCw, AlertTriangle, Download } from 'lucide-vue-next';
import { generateBackupCodes } from '@/api/auth';
import { useToast } from '@/composables/useToast';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const toast = useToast();

type Step = 'password' | 'codes';

const step = ref<Step>('password');
const password = ref('');
const newCodes = ref<string[]>([]);
const codesSaved = ref(false);
const loading = ref(false);
const error = ref('');

watch(() => props.open, (open) => {
  if (open) {
    step.value = 'password';
    password.value = '';
    newCodes.value = [];
    codesSaved.value = false;
    loading.value = false;
    error.value = '';
  }
});

async function handleRegenerate() {
  if (!password.value) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await generateBackupCodes(password.value);
    newCodes.value = result.backupCodes;
    step.value = 'codes';
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('mfa.errors.regenerateFailed');
  } finally {
    loading.value = false;
  }
}

function downloadCodes() {
  const header = `${t('mfa.backupCodes.fileHeader', { app: 'auth-service' })}\n${new Date().toISOString()}\n\n`;
  const blob = new Blob([header + newCodes.value.join('\n') + '\n'], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'auth-service-backup-codes.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function handleClose() {
  if (step.value === 'codes' && !codesSaved.value) return;
  if (step.value === 'codes') toast.success(t('mfa.backupCodes.regeneratedToast'));
  emit('close');
}
</script>

<template>
  <BaseModal :open="open" :title="t('mfa.backupCodes.regenerateTitle')" size="md" @close="handleClose">
    <div v-if="step === 'password'" class="space-y-4">
      <div class="flex items-start gap-3 rounded-lg bg-amber-500/10 border border-amber-500/30 p-3">
        <AlertTriangle class="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
        <p class="text-xs text-amber-200">{{ t('mfa.backupCodes.regenerateWarning') }}</p>
      </div>
      <BaseInput
        v-model="password"
        :label="t('mfa.disable.passwordLabel')"
        type="password"
        required
        :error="error"
        @keyup.enter="handleRegenerate"
      />
    </div>

    <div v-else class="space-y-4">
      <p class="text-sm text-surface-400">{{ t('mfa.backupCodes.intro') }}</p>
      <div class="rounded-lg bg-surface-950/60 border border-surface-700/40 p-4 grid grid-cols-2 gap-2 font-mono text-sm text-surface-200">
        <code v-for="bc in newCodes" :key="bc" class="select-all">{{ bc }}</code>
      </div>
      <BaseButton variant="outline" size="sm" @click="downloadCodes">
        <Download class="w-4 h-4" />
        {{ t('mfa.backupCodes.download') }}
      </BaseButton>
      <label class="flex items-start gap-2 text-sm text-surface-300 cursor-pointer">
        <input v-model="codesSaved" type="checkbox" class="mt-0.5 w-4 h-4 rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500/50" />
        <span>{{ t('mfa.backupCodes.confirm') }}</span>
      </label>
    </div>

    <template #footer>
      <BaseButton v-if="step === 'password'" variant="ghost" @click="emit('close')">
        {{ t('common.cancel') }}
      </BaseButton>
      <BaseButton
        v-if="step === 'password'"
        :loading="loading"
        :disabled="!password"
        @click="handleRegenerate"
      >
        <RefreshCw class="w-4 h-4" />
        {{ t('mfa.backupCodes.regenerateAction') }}
      </BaseButton>

      <BaseButton
        v-if="step === 'codes'"
        :disabled="!codesSaved"
        @click="handleClose"
      >
        {{ t('common.close') }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
