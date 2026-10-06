<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { CircleCheckBig, MailCheck } from 'lucide-vue-next';
import AppLogo from '@/components/branding/AppLogo.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { useAppBranding } from '@/composables/useAppBranding';
import { authPagePath } from '@/utils/authRedirect';

// Post-verification landing page. It is public by design: the verification
// click no longer opens a session, so this page must render for an anonymous
// visitor and must not fetch the session or bounce to a protected area.
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { branding } = useAppBranding();

// Which flow completed travels in `?status=`. An unknown or absent value falls
// back to the neutral wording instead of echoing the query parameter.
const status = computed(() =>
  typeof route.query.status === 'string' ? route.query.status : '',
);

const key = computed(() =>
  status.value === 'activated' || status.value === 'pending' || status.value === 'updated'
    ? status.value
    : 'unknown',
);

const pending = computed(() => key.value === 'pending');

function goToLogin() {
  router.push(authPagePath('/login', route.query));
}
</script>

<template>
  <div class="min-h-screen bg-surface-950 flex items-center justify-center p-4">
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div class="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-primary-600/5 rounded-full blur-3xl" />
    </div>
    <div class="w-full max-w-sm relative">
      <div class="flex flex-col items-center mb-8 text-center">
        <div v-if="!branding.logoUrl" class="w-12 h-12 rounded-2xl bg-primary-600 flex items-center justify-center shadow-xl shadow-primary-900/40 mb-4 overflow-hidden">
          <AppLogo :size="24" icon-class="text-white" />
        </div>
        <div v-else class="mb-4">
          <AppLogo :size="64" icon-class="text-white" />
        </div>
        <h1 class="text-xl font-semibold text-surface-100">{{ t(`pages.emailVerified.${key}Title`) }}</h1>
        <p class="text-sm text-surface-500 mt-1">{{ t(`pages.emailVerified.${key}Subtitle`) }}</p>
      </div>

      <div class="bg-surface-900/60 backdrop-blur-sm border border-surface-700/40 rounded-2xl p-6 shadow-xl text-center space-y-4">
        <div
          class="w-10 h-10 mx-auto rounded-lg flex items-center justify-center"
          :class="pending ? 'bg-primary-600/10' : 'bg-emerald-500/10'"
        >
          <MailCheck v-if="pending" class="w-5 h-5 text-primary-400" />
          <CircleCheckBig v-else class="w-5 h-5 text-emerald-400" />
        </div>
        <p class="text-sm text-surface-300">{{ t(`pages.emailVerified.${key}Body`) }}</p>
        <p class="text-sm text-surface-500">{{ t('pages.emailVerified.signedOut') }}</p>
        <BaseButton class="w-full" @click="goToLogin">
          {{ t('pages.emailVerified.signIn') }}
        </BaseButton>
      </div>
    </div>
  </div>
</template>
