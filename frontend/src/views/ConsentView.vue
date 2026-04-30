<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Shield, Check, X } from 'lucide-vue-next';
import BaseButton from '@/components/ui/BaseButton.vue';

const { t } = useI18n();
const route = useRoute();

// @better-auth/oauth-provider redirects to the consent page with all OAuth
// params signed via HMAC (exp + sig appended). The POST endpoint requires the
// complete raw query string sent as `oauth_query` so the before-hook can verify
// the signature and restore the OAuth state for the consent handler.
const oauthQuery = window.location.search.slice(1);

const clientId = route.query.client_id as string | undefined;
const scopeParam = route.query.scope as string | undefined;

const scopes = computed(() =>
  (scopeParam ?? '').split(' ').filter(Boolean),
);

const SCOPE_LABELS: Record<string, { key: string }> = {
  openid:         { key: 'consent.scopes.openid' },
  profile:        { key: 'consent.scopes.profile' },
  email:          { key: 'consent.scopes.email' },
  offline_access: { key: 'consent.scopes.offlineAccess' },
  roles:          { key: 'consent.scopes.roles' },
  permissions:    { key: 'consent.scopes.permissions' },
  features:       { key: 'consent.scopes.features' },
};

const appName = ref('');
const appIcon = ref<string | null>(null);
const loadError = ref('');
const loading = ref(true);
const submitting = ref(false);
const submitError = ref('');

onMounted(async () => {
  if (!clientId || !oauthQuery.includes('sig=')) {
    loadError.value = t('consent.invalidRequest');
    loading.value = false;
    return;
  }
  try {
    const res = await fetch(`/api/app-config?client_id=${encodeURIComponent(clientId)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    appName.value = data.name ?? clientId;
    appIcon.value = data.icon ?? null;
  } catch {
    loadError.value = t('consent.loadError');
  } finally {
    loading.value = false;
  }
});

async function respond(accept: boolean) {
  submitError.value = '';
  submitting.value = true;
  try {
    const res = await fetch('/api/auth/oauth2/consent', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept, oauth_query: oauthQuery }),
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    window.location.href = data.url;
  } catch {
    submitError.value = t('consent.submitError');
    submitting.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-surface-950 flex items-center justify-center p-4">
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div class="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-primary-600/5 rounded-full blur-3xl" />
    </div>

    <div class="w-full max-w-sm relative">
      <!-- Loading -->
      <div v-if="loading" class="flex flex-col items-center gap-3 text-surface-400">
        <svg class="animate-spin h-6 w-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span class="text-sm">{{ t('common.loading') }}</span>
      </div>

      <!-- Load error -->
      <div v-else-if="loadError" class="flex flex-col items-center text-center gap-4">
        <div class="w-12 h-12 rounded-2xl bg-surface-800 border border-surface-700/60 flex items-center justify-center">
          <Shield class="w-6 h-6 text-surface-400" />
        </div>
        <p class="text-sm text-red-400">{{ loadError }}</p>
      </div>

      <!-- Consent card -->
      <template v-else>
        <!-- App identity -->
        <div class="flex flex-col items-center mb-8">
          <div
            v-if="appIcon"
            class="w-14 h-14 rounded-2xl overflow-hidden bg-surface-800 border border-surface-700/40 flex items-center justify-center mb-4 shadow-xl"
          >
            <img :src="appIcon" :alt="appName" class="w-full h-full object-contain" />
          </div>
          <div
            v-else
            class="w-14 h-14 rounded-2xl bg-primary-600 flex items-center justify-center shadow-xl shadow-primary-900/40 mb-4"
          >
            <Shield class="w-7 h-7 text-white" />
          </div>
          <h1 class="text-xl font-semibold text-surface-100">{{ t('consent.title') }}</h1>
          <p class="text-sm text-surface-400 mt-1 text-center">
            {{ t('consent.subtitle', { app: appName }) }}
          </p>
        </div>

        <!-- Scope list -->
        <div class="bg-surface-900/60 backdrop-blur-sm border border-surface-700/40 rounded-2xl p-5 shadow-xl mb-4">
          <p class="text-xs font-semibold text-surface-500 uppercase tracking-widest mb-3">
            {{ t('consent.permissionsLabel') }}
          </p>
          <ul class="space-y-2.5">
            <li
              v-for="scope in scopes"
              :key="scope"
              class="flex items-start gap-3"
            >
              <span class="mt-0.5 w-4 h-4 rounded-full bg-primary-600/20 flex items-center justify-center flex-shrink-0">
                <Check class="w-2.5 h-2.5 text-primary-400" />
              </span>
              <span class="text-sm text-surface-300">
                {{ SCOPE_LABELS[scope] ? t(SCOPE_LABELS[scope].key) : scope }}
              </span>
            </li>
          </ul>
        </div>

        <!-- Submit error -->
        <p v-if="submitError" class="text-xs text-red-400 text-center mb-3">{{ submitError }}</p>

        <!-- Actions -->
        <div class="flex flex-col gap-2">
          <BaseButton
            size="lg"
            variant="primary"
            :loading="submitting"
            class="w-full"
            @click="respond(true)"
          >
            <Check class="w-4 h-4" />
            {{ t('consent.allow') }}
          </BaseButton>
          <BaseButton
            size="lg"
            variant="outline"
            :disabled="submitting"
            class="w-full"
            @click="respond(false)"
          >
            <X class="w-4 h-4" />
            {{ t('consent.deny') }}
          </BaseButton>
        </div>

        <p class="text-xs text-surface-600 text-center mt-4">
          {{ t('consent.footer') }}
        </p>
      </template>
    </div>
  </div>
</template>
