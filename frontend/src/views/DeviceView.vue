<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Check, X } from 'lucide-vue-next';
import AppLogo from '@/components/branding/AppLogo.vue';
import BaseButton from '@/components/ui/BaseButton.vue';

const { t } = useI18n();
const route = useRoute();

const code = ref((route.query.user_code as string | undefined) ?? '');
const clientId = ref<string | null>(null);
const scopes = ref<string | null>(null);
const status = ref<'idle' | 'ready' | 'approved' | 'denied'>('idle');
const error = ref('');
const busy = ref(false);

async function lookup() {
  error.value = '';
  clientId.value = null;
  scopes.value = null;
  status.value = 'idle';
  const value = code.value.trim();
  if (!value) return;
  try {
    const res = await fetch(
      `/api/auth/device?user_code=${encodeURIComponent(value)}`,
      { credentials: 'include' },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.value = data?.error_description ?? t('device.invalidCode');
      return;
    }
    clientId.value = data.client_id ?? null;
    scopes.value = data.scope ?? null;
    status.value = 'ready';
  } catch {
    error.value = t('device.networkError');
  }
}

async function decide(action: 'approve' | 'deny') {
  busy.value = true;
  error.value = '';
  try {
    const res = await fetch(`/api/auth/device/${action}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: code.value.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.value = data?.error_description ?? t('device.networkError');
      return;
    }
    status.value = action === 'approve' ? 'approved' : 'denied';
    code.value = '';
  } catch {
    error.value = t('device.networkError');
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  if (code.value.trim().length >= 4) lookup();
});
</script>

<template>
  <div class="min-h-screen bg-surface-950 flex items-center justify-center p-4">
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div class="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-primary-600/5 rounded-full blur-3xl" />
    </div>

    <div class="w-full max-w-sm relative">
      <div class="flex flex-col items-center mb-8">
        <div class="w-14 h-14 rounded-2xl bg-primary-600 flex items-center justify-center shadow-xl shadow-primary-900/40 mb-4 overflow-hidden">
          <AppLogo :size="28" icon-class="text-white" />
        </div>
        <h1 class="text-xl font-semibold text-surface-100">{{ t('device.title') }}</h1>
        <p class="text-sm text-surface-400 mt-1 text-center">{{ t('device.subtitle') }}</p>
      </div>

      <div class="bg-surface-900/60 backdrop-blur-sm border border-surface-700/40 rounded-2xl p-5 shadow-xl mb-4">
        <label for="device-code" class="block text-xs font-semibold text-surface-500 uppercase tracking-widest mb-3">
          {{ t('device.codeLabel') }}
        </label>
        <input
          id="device-code"
          v-model="code"
          type="text"
          autocomplete="one-time-code"
          :placeholder="t('device.codePlaceholder')"
          class="w-full text-center tracking-[0.2em] uppercase bg-surface-950 border border-surface-700/60 rounded-lg px-3 py-2.5 text-surface-100 focus:outline-none focus:border-primary-500"
          @input="status = 'idle'"
          @keyup.enter="lookup"
        />

        <p v-if="status === 'ready' && clientId" class="mt-3 text-xs text-surface-400">
          {{ t('device.detailsApp', { app: clientId }) }}
          <span v-if="scopes"><br />{{ t('device.detailsScopes', { scopes }) }}</span>
        </p>
      </div>

      <p v-if="error" class="text-xs text-red-400 text-center mb-3">{{ error }}</p>
      <p v-if="status === 'approved'" class="text-xs text-emerald-400 text-center mb-3">{{ t('device.approved') }}</p>
      <p v-if="status === 'denied'" class="text-xs text-surface-400 text-center mb-3">{{ t('device.denied') }}</p>

      <div class="flex flex-col gap-2">
        <BaseButton
          v-if="status !== 'ready'"
          size="lg"
          variant="primary"
          class="w-full"
          :disabled="!code.trim()"
          @click="lookup"
        >
          {{ t('device.codeLabel') }}
        </BaseButton>
        <template v-else>
          <BaseButton size="lg" variant="primary" class="w-full" :loading="busy" @click="decide('approve')">
            <Check class="w-4 h-4" />
            {{ t('device.approve') }}
          </BaseButton>
          <BaseButton size="lg" variant="outline" class="w-full" :disabled="busy" @click="decide('deny')">
            <X class="w-4 h-4" />
            {{ t('device.deny') }}
          </BaseButton>
        </template>
      </div>
    </div>
  </div>
</template>
