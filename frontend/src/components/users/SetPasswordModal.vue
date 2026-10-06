<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { KeyRound } from 'lucide-vue-next';
import { setUserPassword } from '@/api/users';
import { useToast } from '@/composables/useToast';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import PasswordStrengthMeter from '@/components/auth/PasswordStrengthMeter.vue';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '@/utils/passwordStrength';

const props = defineProps<{ open: boolean; userId: string | null }>();
const emit = defineEmits<{ close: []; success: [] }>();

const { t } = useI18n();
const toast = useToast();

const newPassword = ref('');
const confirmation = ref('');
const loading = ref(false);
const error = ref('');

watch(
  () => props.open,
  (open) => {
    if (open) reset();
  },
);

function reset() {
  newPassword.value = '';
  confirmation.value = '';
  loading.value = false;
  error.value = '';
}

const mismatch = computed(
  () => confirmation.value.length > 0 && confirmation.value !== newPassword.value,
);

const tooShort = computed(
  () => newPassword.value.length > 0 && newPassword.value.length < MIN_PASSWORD_LENGTH,
);

// Same policy as the server (`minPasswordLength: 8`, max 128): the form must
// never refuse something the server would accept.
const canSubmit = computed(
  () =>
    props.userId !== null &&
    newPassword.value.length >= MIN_PASSWORD_LENGTH &&
    newPassword.value.length <= MAX_PASSWORD_LENGTH &&
    confirmation.value === newPassword.value,
);

async function handleSubmit() {
  if (!canSubmit.value || loading.value || props.userId === null) return;
  loading.value = true;
  error.value = '';
  try {
    await setUserPassword(props.userId, newPassword.value);
    toast.success(t('users.setPasswordSuccess'));
    emit('success');
    emit('close');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('users.setPasswordError');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('users.setPassword')"
    size="sm"
    @close="emit('close')"
  >
    <form class="space-y-4" @submit.prevent="handleSubmit">
      <div class="space-y-2">
        <BaseInput
          v-model="newPassword"
          :label="t('users.setPasswordNew')"
          type="password"
          :placeholder="t('auth.passwordPlaceholder')"
          autocomplete="new-password"
          :error="tooShort ? t('auth.passwordTooShort', { min: MIN_PASSWORD_LENGTH }) : undefined"
          required
        />
        <PasswordStrengthMeter :password="newPassword" />
      </div>
      <BaseInput
        v-model="confirmation"
        :label="t('users.setPasswordConfirm')"
        type="password"
        :placeholder="t('auth.passwordPlaceholder')"
        autocomplete="new-password"
        :error="mismatch ? t('auth.passwordMismatch') : undefined"
        required
      />
      <p class="text-xs text-surface-500">{{ t('users.setPasswordRevokesSessions') }}</p>
      <p v-if="error" class="text-sm text-red-400">{{ error }}</p>
    </form>
    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
      <BaseButton :loading="loading" :disabled="!canSubmit" @click="handleSubmit">
        <KeyRound class="w-4 h-4" />
        {{ t('users.setPasswordAction') }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
