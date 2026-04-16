<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { Shield, LogIn } from 'lucide-vue-next';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseButton from '@/components/ui/BaseButton.vue';

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();

const email = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

async function handleLogin() {
  if (!email.value || !password.value) return;
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value, password: password.value }),
    });
    if (!res.ok) {
      error.value = 'Invalid credentials';
      return;
    }
    await auth.fetchSession();
    if (auth.user) {
      await router.push('/dashboard');
    }
  } catch {
    error.value = 'Network error';
  } finally {
    loading.value = false;
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
        <div class="w-12 h-12 rounded-2xl bg-primary-600 flex items-center justify-center shadow-xl shadow-primary-900/40 mb-4">
          <Shield class="w-6 h-6 text-white" />
        </div>
        <h1 class="text-xl font-semibold text-surface-100">{{ t('auth.loginTitle') }}</h1>
        <p class="text-sm text-surface-500 mt-1">{{ t('auth.loginSubtitle') }}</p>
      </div>

      <form @submit.prevent="handleLogin" class="bg-surface-900/60 backdrop-blur-sm border border-surface-700/40 rounded-2xl p-6 space-y-4 shadow-xl">
        <BaseInput
          v-model="email"
          :label="t('auth.email')"
          type="email"
          placeholder="admin@example.com"
          required
        />
        <BaseInput
          v-model="password"
          :label="t('auth.password')"
          type="password"
          placeholder="••••••••"
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
</template>
