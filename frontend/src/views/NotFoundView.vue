<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { FileQuestion } from 'lucide-vue-next';

const { t } = useI18n();
const router = useRouter();
</script>

<template>
  <div class="min-h-screen bg-surface-950 flex items-center justify-center p-4">
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <div class="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-primary-600/5 rounded-full blur-3xl" />
    </div>
    <div class="w-full max-w-sm relative flex flex-col items-center text-center">
      <div class="w-12 h-12 rounded-2xl bg-surface-800 border border-surface-700/60 flex items-center justify-center mb-6">
        <FileQuestion class="w-6 h-6 text-surface-400" />
      </div>
      <span class="text-xs font-semibold text-surface-500 uppercase tracking-widest mb-3">404</span>
      <h1 class="text-xl font-semibold text-surface-100 mb-2">{{ t('pages.notFound.title') }}</h1>
      <p class="text-sm text-surface-500 mb-8">{{ t('pages.notFound.subtitle') }}</p>
      <button
        class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium transition-colors"
        @click="router.push('/dashboard')"
      >
        {{ t('pages.notFound.back') }}
      </button>
    </div>
  </div>
</template>
