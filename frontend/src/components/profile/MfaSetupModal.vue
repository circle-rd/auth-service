<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import QRCode from 'qrcode';
import { ShieldCheck, Smartphone, Key as KeyIcon, CheckCircle, Download } from 'lucide-vue-next';
import { enableTwoFactor, verifyTotp } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import CopyField from '@/components/ui/CopyField.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; success: [] }>();

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToast();

type Step = 'password' | 'scan' | 'verify' | 'codes';

const step = ref<Step>('password');
const password = ref('');
const code = ref('');
const totpURI = ref('');
const totpSecret = ref('');
const qrDataUrl = ref('');
const backupCodes = ref<string[]>([]);
const codesSaved = ref(false);
const loading = ref(false);
const error = ref('');

function reset() {
  step.value = 'password';
  password.value = '';
  code.value = '';
  totpURI.value = '';
  totpSecret.value = '';
  qrDataUrl.value = '';
  backupCodes.value = [];
  codesSaved.value = false;
  loading.value = false;
  error.value = '';
}

watch(() => props.open, (open) => {
  if (open) reset();
});

// Extract the base32 secret from the otpauth:// URI to display as a fallback
// when the user cannot scan the QR code.
function extractSecret(uri: string): string {
  try {
    const url = new URL(uri);
    return url.searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

async function handlePasswordSubmit() {
  if (!password.value) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await enableTwoFactor(password.value);
    totpURI.value = result.totpURI;
    totpSecret.value = extractSecret(result.totpURI);
    backupCodes.value = result.backupCodes;
    qrDataUrl.value = await QRCode.toDataURL(result.totpURI, {
      width: 220,
      margin: 1,
      color: { dark: '#f1f5f9', light: '#0f172a' },
    });
    step.value = 'scan';
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('mfa.errors.enableFailed');
  } finally {
    loading.value = false;
  }
}

async function handleVerify() {
  if (code.value.length !== 6) return;
  loading.value = true;
  error.value = '';
  try {
    await verifyTotp(code.value);
    step.value = 'codes';
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('mfa.errors.invalidCode');
  } finally {
    loading.value = false;
  }
}

function downloadCodes() {
  const header = `${t('mfa.backupCodes.fileHeader', { app: 'auth-service' })}\n${new Date().toISOString()}\n\n`;
  const blob = new Blob([header + backupCodes.value.join('\n') + '\n'], {
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

async function handleFinish() {
  await auth.fetchSession();
  toast.success(t('mfa.setup.successToast'));
  emit('success');
  emit('close');
}

function handleClose() {
  // Allow closing during password/scan/verify steps; on the codes step the
  // user must explicitly confirm they have saved the codes.
  if (step.value === 'codes' && !codesSaved.value) return;
  emit('close');
}
</script>

<template>
  <BaseModal :open="open" :title="t('mfa.setup.title')" size="md" @close="handleClose">
    <!-- Step 1: password confirmation -->
    <div v-if="step === 'password'" class="space-y-4">
      <p class="text-sm text-surface-400">{{ t('mfa.setup.passwordIntro') }}</p>
      <BaseInput
        v-model="password"
        :label="t('mfa.setup.passwordLabel')"
        type="password"
        :placeholder="t('mfa.setup.passwordPlaceholder')"
        required
        :error="error"
        @keyup.enter="handlePasswordSubmit"
      />
    </div>

    <!-- Step 2: scan QR code -->
    <div v-else-if="step === 'scan'" class="space-y-4">
      <p class="text-sm text-surface-400 flex items-start gap-2">
        <Smartphone class="w-4 h-4 text-primary-400 mt-0.5 shrink-0" />
        <span>{{ t('mfa.setup.scanIntro') }}</span>
      </p>
      <div class="flex justify-center py-2">
        <div class="rounded-xl bg-surface-950/60 border border-surface-700/40 p-3">
          <img :src="qrDataUrl" :alt="t('mfa.setup.qrAlt')" class="w-[220px] h-[220px]" />
        </div>
      </div>
      <details class="text-xs text-surface-500">
        <summary class="cursor-pointer hover:text-surface-300">{{ t('mfa.setup.manualEntryToggle') }}</summary>
        <div class="mt-3">
          <CopyField :value="totpSecret" :label="t('mfa.setup.secretLabel')" />
        </div>
      </details>
    </div>

    <!-- Step 3: verify code -->
    <div v-else-if="step === 'verify'" class="space-y-4">
      <p class="text-sm text-surface-400">{{ t('mfa.setup.verifyIntro') }}</p>
      <BaseInput
        v-model="code"
        :label="t('mfa.code')"
        :placeholder="t('mfa.codePlaceholder')"
        :error="error"
        inputmode="numeric"
        autocomplete="one-time-code"
        @keyup.enter="handleVerify"
      />
    </div>

    <!-- Step 4: backup codes -->
    <div v-else class="space-y-4">
      <div class="flex items-start gap-2">
        <ShieldCheck class="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
        <div>
          <p class="text-sm font-medium text-surface-200">{{ t('mfa.backupCodes.title') }}</p>
          <p class="text-xs text-surface-500 mt-0.5">{{ t('mfa.backupCodes.intro') }}</p>
        </div>
      </div>
      <div class="rounded-lg bg-surface-950/60 border border-surface-700/40 p-4 grid grid-cols-2 gap-2 font-mono text-sm text-surface-200">
        <code v-for="bc in backupCodes" :key="bc" class="select-all">{{ bc }}</code>
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
        @click="handlePasswordSubmit"
      >
        {{ t('common.next') }}
      </BaseButton>

      <BaseButton v-if="step === 'scan'" variant="ghost" @click="emit('close')">
        {{ t('common.cancel') }}
      </BaseButton>
      <BaseButton v-if="step === 'scan'" @click="step = 'verify'">
        {{ t('common.next') }}
      </BaseButton>

      <BaseButton v-if="step === 'verify'" variant="ghost" @click="step = 'scan'">
        {{ t('common.back') }}
      </BaseButton>
      <BaseButton
        v-if="step === 'verify'"
        :loading="loading"
        :disabled="code.length !== 6"
        @click="handleVerify"
      >
        <CheckCircle class="w-4 h-4" />
        {{ t('mfa.setup.verifyAction') }}
      </BaseButton>

      <BaseButton
        v-if="step === 'codes'"
        :disabled="!codesSaved"
        @click="handleFinish"
      >
        <KeyIcon class="w-4 h-4" />
        {{ t('mfa.setup.finishAction') }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
