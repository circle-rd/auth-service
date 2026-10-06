<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { CircleCheckBig, KeyRound, TriangleAlert } from 'lucide-vue-next';
import AppLogo from '@/components/branding/AppLogo.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import PasswordStrengthMeter from '@/components/auth/PasswordStrengthMeter.vue';
import { resetPassword } from '@/api/auth';
import { useAppBranding } from '@/composables/useAppBranding';
import { authPagePath } from '@/utils/authRedirect';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '@/utils/passwordStrength';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { branding } = useAppBranding();

// BetterAuth's reset callback (`GET /api/auth/reset-password/:token`, the link
// inside the e-mail) validates the token and redirects to the `redirectTo` we
// asked for, appending `?token=<token>` — or `?error=INVALID_TOKEN` when the
// token is unknown or expired. The path form is also accepted so a direct
// `<origin>/reset-password/<token>` link works too.
const token = computed(() => {
  const fromPath = route.params.token;
  const pathValue = Array.isArray(fromPath) ? (fromPath[0] ?? '') : (fromPath ?? '');
  if (pathValue) return pathValue;
  const fromQuery = route.query.token;
  return typeof fromQuery === 'string' ? fromQuery : '';
});

const callbackError = computed(() =>
  typeof route.query.error === 'string' ? route.query.error : '',
);

const password = ref('');
const confirmation = ref('');
const loading = ref(false);
const done = ref(false);
const error = ref('');

const invalidToken = computed(() => Boolean(callbackError.value) || !token.value);
const mismatch = computed(
  () => confirmation.value.length > 0 && confirmation.value !== password.value,
);

// Mirrors the server policy exactly (min 8, max 128): the form refuses nothing
// the server would accept, and the strength meter stays advisory.
const tooShort = computed(
  () => password.value.length > 0 && password.value.length < MIN_PASSWORD_LENGTH,
);

const canSubmit = computed(
  () =>
    !invalidToken.value &&
    password.value.length >= MIN_PASSWORD_LENGTH &&
    password.value.length <= MAX_PASSWORD_LENGTH &&
    confirmation.value === password.value,
);

async function handleSubmit() {
  if (!canSubmit.value || loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    await resetPassword(token.value, password.value);
    done.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('auth.resetPasswordError');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-surface-950 flex items-center justify-center p-4">
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div class="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-primary-600/5 rounded-full blur-3xl" />
    </div>
    <div class="w-full max-w-sm relative">
      <div class="flex flex-col items-center mb-8">
        <div v-if="!branding.logoUrl" class="w-12 h-12 rounded-2xl bg-primary-600 flex items-center justify-center shadow-xl shadow-primary-900/40 mb-4 overflow-hidden">
          <AppLogo :size="24" icon-class="text-white" />
        </div>
        <div v-else class="mb-4">
          <AppLogo :size="64" icon-class="text-white" />
        </div>
        <h1 class="text-xl font-semibold text-surface-100">{{ t('auth.resetPasswordTitle') }}</h1>
        <p class="text-sm text-surface-500 mt-1">{{ t('auth.resetPasswordSubtitle') }}</p>
      </div>

      <div class="bg-surface-900/60 backdrop-blur-sm border border-surface-700/40 rounded-2xl p-6 shadow-xl">
        <!-- Missing or expired token: the link cannot be used again. -->
        <div v-if="invalidToken" class="space-y-4 text-center">
          <div class="w-10 h-10 mx-auto rounded-lg bg-red-500/10 flex items-center justify-center">
            <TriangleAlert class="w-5 h-5 text-red-400" />
          </div>
          <p class="text-sm text-surface-300">{{ t('auth.resetTokenInvalid') }}</p>
          <BaseButton
            class="w-full"
            @click="router.push(authPagePath('/forgot-password', route.query))"
          >
            {{ t('auth.requestNewLink') }}
          </BaseButton>
        </div>

        <div v-else-if="done" class="space-y-4 text-center">
          <div class="w-10 h-10 mx-auto rounded-lg bg-emerald-500/10 flex items-center justify-center">
            <CircleCheckBig class="w-5 h-5 text-emerald-400" />
          </div>
          <p class="text-sm text-surface-300">{{ t('auth.resetPasswordDone') }}</p>
          <BaseButton
            class="w-full"
            @click="router.push(authPagePath('/login', route.query))"
          >
            {{ t('auth.backToLogin') }}
          </BaseButton>
        </div>

        <form v-else @submit.prevent="handleSubmit" class="space-y-4">
          <div class="space-y-2">
            <BaseInput
              v-model="password"
              :label="t('auth.newPassword')"
              type="password"
              :placeholder="t('auth.passwordPlaceholder')"
              autocomplete="new-password"
              :error="tooShort ? t('auth.passwordTooShort', { min: MIN_PASSWORD_LENGTH }) : undefined"
              required
            />
            <PasswordStrengthMeter :password="password" />
          </div>
          <BaseInput
            v-model="confirmation"
            :label="t('auth.confirmPassword')"
            type="password"
            :placeholder="t('auth.passwordPlaceholder')"
            autocomplete="new-password"
            :error="mismatch ? t('auth.passwordMismatch') : undefined"
            required
          />
          <p v-if="error" class="text-sm text-red-400 text-center">{{ error }}</p>
          <BaseButton type="submit" class="w-full" :loading="loading" size="lg" :disabled="!canSubmit">
            <KeyRound class="w-4 h-4" />
            {{ t('auth.resetPasswordAction') }}
          </BaseButton>
        </form>
      </div>
    </div>
  </div>
</template>
