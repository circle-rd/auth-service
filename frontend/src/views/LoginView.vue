<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { LogIn } from 'lucide-vue-next';
import AppLogo from '@/components/branding/AppLogo.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import MfaChallengeForm from '@/components/auth/MfaChallengeForm.vue';

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const email = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

function nextRoute(): string {
  // Preserve a `redirectTo` query param so OAuth flows (which carry signed
  // params via `?client_id=...&sig=...`) resume after a successful sign-in.
  const redirect = route.query.redirectTo;
  if (typeof redirect === 'string' && redirect.startsWith('/')) return redirect;
  return '/dashboard';
}

async function handleLogin() {
  if (!email.value || !password.value) return;
  loading.value = true;
  error.value = '';
  try {
    await auth.signInEmail(email.value, password.value);
    if (auth.mfaPending) {
      // The MfaChallengeForm component now drives the second step.
      return;
    }
    if (auth.user) {
      await router.push(nextRoute());
    } else {
      error.value = t('auth.invalidCredentials');
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('auth.invalidCredentials');
  } finally {
    loading.value = false;
  }
}

async function handleMfaVerified() {
  if (auth.user) {
    // Navigate FIRST, then clear the MFA-pending flag. Clearing it before
    // navigation would unmount the challenge form before the router push
    // completes, briefly re-rendering the email/password form.
    await router.push(nextRoute());
    auth.clearMfaPending();
  }
}

if (import.meta.env.VITE_USE_MOCK === 'true') {
  auth.fetchSession().then(() => {
    if (auth.user) router.push('/dashboard');
  });
}
</script>

<template>
  <div class="min-h-screen bg-surface-950 flex items-center justify-center p-4">
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div class="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-primary-600/5 rounded-full blur-3xl" />
    </div>
    <div class="w-full max-w-sm relative">
      <div class="flex flex-col items-center mb-8">
        <div class="w-12 h-12 rounded-2xl bg-primary-600 flex items-center justify-center shadow-xl shadow-primary-900/40 mb-4 overflow-hidden">
          <AppLogo :size="24" icon-class="text-white" />
        </div>
        <h1 class="text-xl font-semibold text-surface-100">{{ t('auth.loginTitle') }}</h1>
        <p class="text-sm text-surface-500 mt-1">
          {{ auth.mfaPending ? t('mfa.challenge.subtitle') : t('auth.loginSubtitle') }}
        </p>
      </div>

      <div class="bg-surface-900/60 backdrop-blur-sm border border-surface-700/40 rounded-2xl p-6 shadow-xl">
        <MfaChallengeForm v-if="auth.mfaPending" @verified="handleMfaVerified" />

        <form v-else @submit.prevent="handleLogin" class="space-y-4">
          <BaseInput
            v-model="email"
            :label="t('auth.email')"
            type="email"
            placeholder="admin@example.com"
            autocomplete="username"
            required
          />
          <BaseInput
            v-model="password"
            :label="t('auth.password')"
            type="password"
            placeholder="••••••••"
            autocomplete="current-password"
            required
          />
          <p v-if="error" class="text-sm text-red-400 text-center">{{ error }}</p>
          <BaseButton type="submit" class="w-full" :loading="loading" size="lg">
            <LogIn class="w-4 h-4" />
            {{ t('auth.login') }}
          </BaseButton>
        </form>
      </div>
    </div>
  </div>
</template>
