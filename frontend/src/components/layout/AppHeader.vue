<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useTheme } from '@/composables/useTheme';
import { setLocale } from '@/i18n';
import { Sun, Moon, Globe } from 'lucide-vue-next';
import { computed } from 'vue';

const { t, locale } = useI18n();
const { theme, toggle } = useTheme();

defineProps<{
  title?: string;
  subtitle?: string;
}>();

const otherLocale = computed(() => locale.value === 'en' ? 'fr' : 'en');

function toggleLocale() {
  setLocale(otherLocale.value as 'en' | 'fr');
}

void t; // suppress unused warning
</script>

<template>
  <header class="h-16 shrink-0 flex items-center justify-between px-6 border-b border-surface-800/40 bg-surface-950/40 backdrop-blur-xl">
    <div>
      <h1 v-if="title" class="text-base font-semibold text-surface-100">{{ title }}</h1>
      <p v-if="subtitle" class="text-xs text-surface-500">{{ subtitle }}</p>
    </div>

    <div class="flex items-center gap-2">
      <button
        @click="toggleLocale"
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-surface-400 hover:text-surface-200 hover:bg-surface-800/60 transition-colors"
        :title="`Switch to ${otherLocale.toUpperCase()}`"
      >
        <Globe class="w-3.5 h-3.5" />
        {{ locale.toUpperCase() }}
      </button>

      <button
        @click="toggle"
        class="p-2 rounded-md text-surface-400 hover:text-surface-200 hover:bg-surface-800/60 transition-colors"
      >
        <Sun v-if="theme === 'dark'" class="w-4 h-4" />
        <Moon v-else class="w-4 h-4" />
      </button>
    </div>
  </header>
</template>
