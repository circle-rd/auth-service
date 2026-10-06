<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { KeyRound } from 'lucide-vue-next';
import { changePassword } from '@/api/auth';
import { useToast } from '@/composables/useToast';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import PasswordStrengthMeter from '@/components/auth/PasswordStrengthMeter.vue';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '@/utils/passwordStrength';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; success: [] }>();

const { t } = useI18n();
const toast = useToast();

const currentPassword = ref('');
const newPassword = ref('');
const confirmation = ref('');
const revokeOtherSessions = ref(true);
const loading = ref(false);
const error = ref('');

watch(() => props.open, (open) => {
  if (open) reset();
});

function reset() {
  currentPassword.value = '';
  newPassword.value = '';
  confirmation.value = '';
  revokeOtherSessions.value = true;
  loading.value = false;
  error.value = '';
}

const mismatch = computed(
  () => confirmation.value.length > 0 && confirmation.value !== newPassword.value,
);

const tooShort = computed(
  () => newPassword.value.length > 0 && newPassword.value.length < MIN_PASSWORD_LENGTH,
);

// Same policy as the server (`minPasswordLength: 8`, max 128).
const canSubmit = computed(
  () =>
    currentPassword.value.length > 0 &&
    newPassword.value.length >= MIN_PASSWORD_LENGTH &&
    newPassword.value.length <= MAX_PASSWORD_LENGTH &&
    confirmation.value === newPassword.value,
);

async function handleSubmit() {
  if (!canSubmit.value || loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    await changePassword(
      currentPassword.value,
      newPassword.value,
      revokeOtherSessions.value,
    );
    toast.success(t('profile.changePasswordSuccess'));
    emit('success');
    emit('close');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('profile.changePasswordError');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <BaseModal :open="open" :title="t('profile.changePassword')" size="sm" @close="emit('close')">
    <form class="space-y-4" @submit.prevent="handleSubmit">
      <BaseInput
        v-model="currentPassword"
        :label="t('profile.currentPassword')"
        type="password"
        :placeholder="t('auth.passwordPlaceholder')"
        autocomplete="current-password"
        required
      />
      <div class="space-y-2">
        <BaseInput
          v-model="newPassword"
          :label="t('profile.newPassword')"
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
        :label="t('profile.confirmPassword')"
        type="password"
        :placeholder="t('auth.passwordPlaceholder')"
        autocomplete="new-password"
        :error="mismatch ? t('auth.passwordMismatch') : undefined"
        required
      />
      <BaseToggle
        v-model="revokeOtherSessions"
        :label="t('profile.revokeOtherSessions')"
        :description="t('profile.revokeOtherSessionsDesc')"
      />
      <p v-if="error" class="text-sm text-red-400">{{ error }}</p>
    </form>
    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
      <BaseButton :loading="loading" :disabled="!canSubmit" @click="handleSubmit">
        <KeyRound class="w-4 h-4" />
        {{ t('profile.changePasswordAction') }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
