<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { ArrowLeft, MailCheck, Send } from 'lucide-vue-next';
import AppLogo from '@/components/branding/AppLogo.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { requestPasswordReset } from '@/api/auth';
import { useAppBranding } from '@/composables/useAppBranding';
import { authPagePath } from '@/utils/authRedirect';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { branding } = useAppBranding();

const email = ref('');
const loading = ref(false);
const submitted = ref(false);
const error = ref('');

async function handleSubmit() {
  if (!email.value || loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    // The callback must be an absolute URL: the link is opened outside the
    // browser session that requested it, and BetterAuth resolves a relative
    // value against its own base URL otherwise. BetterAuth redirects to it
    // with the reset token (or `?error=INVALID_TOKEN`) appended.
    await requestPasswordReset(
      email.value,
      `${window.location.origin}/reset-password`,
    );
    submitted.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('auth.resetRequestError');
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
        <h1 class="text-xl font-semibold text-surface-100">{{ t('auth.forgotPasswordTitle') }}</h1>
        <p class="text-sm text-surface-500 mt-1">{{ t('auth.forgotPasswordSubtitle') }}</p>
      </div>

      <div class="bg-surface-900/60 backdrop-blur-sm border border-surface-700/40 rounded-2xl p-6 shadow-xl">
        <!-- Confirmation is intentionally identical whether or not the address
             matches an account: no account-enumeration oracle. -->
        <div v-if="submitted" class="space-y-4 text-center">
          <div class="w-10 h-10 mx-auto rounded-lg bg-emerald-500/10 flex items-center justify-center">
            <MailCheck class="w-5 h-5 text-emerald-400" />
          </div>
          <p class="text-sm text-surface-300">{{ t('auth.resetRequestSent') }}</p>
          <BaseButton
            variant="outline"
            class="w-full"
            @click="router.push(authPagePath('/login', route.query))"
          >
            <ArrowLeft class="w-4 h-4" />
            {{ t('auth.backToLogin') }}
          </BaseButton>
        </div>

        <form v-else @submit.prevent="handleSubmit" class="space-y-4">
          <BaseInput
            v-model="email"
            :label="t('auth.email')"
            type="email"
            placeholder="admin@example.com"
            autocomplete="username"
            required
          />
          <p v-if="error" class="text-sm text-red-400 text-center">{{ error }}</p>
          <BaseButton type="submit" class="w-full" :loading="loading" size="lg">
            <Send class="w-4 h-4" />
            {{ t('auth.sendResetLink') }}
          </BaseButton>
          <button
            type="button"
            class="w-full text-sm text-primary-400 hover:text-primary-300 underline underline-offset-2"
            @click="router.push(authPagePath('/login', route.query))"
          >
            {{ t('auth.backToLogin') }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
