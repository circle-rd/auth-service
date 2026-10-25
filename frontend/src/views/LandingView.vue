<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  ArrowRight,
  Building2,
  Clock,
  CloudCog,
  CreditCard,
  Fingerprint,
  Globe,
  Layers,
  Mail,
  Moon,
  Palette,
  ShieldCheck,
  Sun,
  Wallet,
} from 'lucide-vue-next';
import AppLogo from '@/components/branding/AppLogo.vue';
import GithubIcon from '@/components/ui/GithubIcon.vue';
import LanguageSelect from '@/components/ui/LanguageSelect.vue';
import { useAppBranding } from '@/composables/useAppBranding';
import { useTheme } from '@/composables/useTheme';

const GITHUB_URL = 'https://github.com/circle-rd/auth-service';
const DOCS_URL = 'https://docs.circle-cyber.com/auth-service';
const VENDOR_URL = 'https://circle-cyber.com';
const MANAGED_URL = 'https://lagarde-cyber.com';
const MANAGED_EMAIL = 'contact@lagarde-cyber.com';

const { t, tm, rt } = useI18n();
const { branding } = useAppBranding();
const { theme, toggle } = useTheme();

const features = [
  { id: 'oidc', icon: ShieldCheck },
  { id: 'rbac', icon: Layers },
  { id: 'mfa', icon: Fingerprint },
  { id: 'organizations', icon: Building2 },
  { id: 'social', icon: Globe },
  { id: 'billing', icon: CreditCard },
  { id: 'wallet', icon: Wallet },
  { id: 'history', icon: Clock },
  { id: 'branding', icon: Palette },
] as const;

const standards = ['web', 'machines', 'agents'] as const;

function messages(key: string): string[] {
  return (tm(key) as Parameters<typeof rt>[0][]).map((m) => rt(m));
}
</script>

<template>
  <div class="min-h-screen bg-surface-950 text-surface-100 flex flex-col">
    <!-- Top nav -->
    <header class="border-b border-surface-800/60">
      <nav class="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
        <div class="flex items-center gap-2 text-sm font-medium tracking-tight">
          <AppLogo :size="24" icon-class="text-surface-100" />
          {{ branding.appName }}
        </div>
        <div class="flex items-center gap-4 text-xs text-surface-400">
          <a href="#features" class="hidden md:inline hover:text-surface-100 transition-colors">{{ t('landing.navFeatures') }}</a>
          <a href="#standards" class="hidden md:inline hover:text-surface-100 transition-colors">{{ t('landing.navStandards') }}</a>
          <a href="#security" class="hidden md:inline hover:text-surface-100 transition-colors">{{ t('landing.navSecurity') }}</a>
          <a
            :href="GITHUB_URL"
            target="_blank"
            rel="noopener noreferrer"
            class="hidden sm:flex items-center gap-1.5 hover:text-surface-100 transition-colors"
          >
            <GithubIcon class="w-[13px] h-[13px]" />
            GitHub
          </a>
          <LanguageSelect />
          <button
            type="button"
            class="w-7 h-7 flex items-center justify-center text-surface-500 hover:text-surface-100 transition-colors rounded-sm hover:bg-surface-800/60"
            :title="theme === 'dark' ? t('landing.themeToLight') : t('landing.themeToDark')"
            :aria-label="theme === 'dark' ? t('landing.themeToLight') : t('landing.themeToDark')"
            @click="toggle"
          >
            <Sun v-if="theme === 'dark'" class="w-[15px] h-[15px]" />
            <Moon v-else class="w-[15px] h-[15px]" />
          </button>
          <RouterLink
            to="/auth"
            class="px-3 py-1.5 rounded-lg border border-surface-700 text-surface-200 hover:border-surface-500 hover:text-surface-50 transition-colors"
          >
            {{ t('landing.signIn') }}
          </RouterLink>
        </div>
      </nav>
    </header>

    <main class="flex-1">
      <!-- Hero -->
      <section class="relative px-6 pt-24 pb-16 text-center overflow-hidden">
        <div class="absolute inset-0 pointer-events-none" aria-hidden="true">
          <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[640px] h-[420px] bg-primary-600/10 rounded-full blur-3xl" />
        </div>
        <div class="relative max-w-4xl mx-auto">
          <div class="mb-8 flex justify-center">
            <AppLogo :size="140" icon-class="text-surface-100" class="opacity-90" />
          </div>
          <span
            class="inline-flex items-center gap-1.5 mb-6 px-3 py-1 text-[11px] uppercase tracking-widest font-medium text-surface-400 border border-surface-800 rounded-full bg-surface-900"
          >
            <ShieldCheck class="w-3 h-3" />
            {{ t('landing.badge') }}
          </span>
          <h1 class="text-[40px] md:text-[56px] leading-[1.05] font-medium tracking-[-0.012em] mb-6">
            {{ t('landing.heroTitle') }}
            <span class="block mt-3 text-[24px] md:text-[34px] leading-[1.15] text-surface-400">
              {{ t('landing.heroSubtitle') }}
            </span>
          </h1>
          <p class="text-base text-surface-400 max-w-[62ch] mx-auto mb-3 leading-[1.55]">
            {{ t('landing.heroLede', { appName: branding.appName }) }}
          </p>
          <p class="text-sm text-surface-500 max-w-[62ch] mx-auto mb-10">
            {{ t('landing.heroNote') }}
          </p>

          <div class="flex items-center justify-center gap-3 flex-wrap">
            <RouterLink
              to="/auth"
              class="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-primary-600 hover:bg-primary-500 text-white shadow-sm shadow-primary-900/30 transition-colors"
            >
              {{ t('landing.signIn') }}
              <ArrowRight class="w-[15px] h-[15px]" />
            </RouterLink>
            <a
              :href="DOCS_URL"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg border border-surface-700 text-surface-100 hover:bg-surface-900 transition-colors"
            >
              {{ t('landing.docs') }}
            </a>
          </div>
        </div>
      </section>

      <!-- Hero screenshot -->
      <section class="px-6 pb-20">
        <div class="max-w-6xl mx-auto">
          <div class="border border-surface-800 rounded-xl overflow-hidden shadow-2xl bg-surface-900 max-h-[560px]">
            <img
              src="/screenshots/dashboard.png"
              :alt="t('landing.screenshotAlt')"
              loading="lazy"
              class="w-full h-auto block"
            />
          </div>
          <p class="text-xs text-surface-500 mt-3 text-center max-w-[60ch] mx-auto">
            {{ t('landing.screenshotCaption') }}
          </p>
        </div>
      </section>

      <!-- Features -->
      <section id="features" class="px-6 pb-20 scroll-mt-8">
        <div class="max-w-7xl mx-auto">
          <div class="mb-8 max-w-3xl">
            <div class="flex items-center gap-2 text-[11px] uppercase tracking-widest font-medium text-surface-500 mb-3">
              <span class="text-primary-400"><Layers class="w-[18px] h-[18px]" /></span>
              {{ t('landing.featuresKicker') }}
            </div>
            <h2 class="text-2xl md:text-3xl font-medium tracking-tight mb-3">
              {{ t('landing.featuresTitle') }}
            </h2>
            <p class="text-sm text-surface-400 leading-relaxed">{{ t('landing.featuresLede') }}</p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 2xl:gap-6">
            <div
              v-for="feature in features"
              :key="feature.id"
              class="bg-surface-900 border border-surface-800 rounded-xl p-5"
            >
              <div class="flex items-center gap-2 mb-3">
                <span class="text-primary-400"><component :is="feature.icon" class="w-[18px] h-[18px]" /></span>
                <h3 class="text-sm font-medium">{{ t(`landing.features.${feature.id}.title`) }}</h3>
              </div>
              <p class="text-xs text-surface-400 leading-relaxed">
                {{ t(`landing.features.${feature.id}.description`) }}
              </p>
            </div>
          </div>
        </div>
      </section>

      <!-- Standards -->
      <section id="standards" class="px-6 pb-20 scroll-mt-8">
        <div class="max-w-7xl mx-auto">
          <div class="mb-8 max-w-3xl">
            <div class="flex items-center gap-2 text-[11px] uppercase tracking-widest font-medium text-surface-500 mb-3">
              <span class="text-primary-400"><ShieldCheck class="w-[18px] h-[18px]" /></span>
              {{ t('landing.standardsKicker') }}
            </div>
            <h2 class="text-2xl md:text-3xl font-medium tracking-tight mb-3">
              {{ t('landing.standardsTitle') }}
            </h2>
            <p class="text-sm text-surface-400 leading-relaxed">{{ t('landing.standardsLede') }}</p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-4 2xl:gap-6">
            <div
              v-for="standard in standards"
              :key="standard"
              class="bg-surface-900 border border-surface-800 rounded-xl p-5"
            >
              <h3 class="text-sm font-medium mb-3">{{ t(`landing.standards.${standard}.title`) }}</h3>
              <ul class="space-y-2">
                <li
                  v-for="item in messages(`landing.standards.${standard}.items`)"
                  :key="item"
                  class="flex items-start gap-2 text-xs text-surface-400 leading-relaxed"
                >
                  <span class="shrink-0 mt-[6px] w-1 h-1 rounded-full bg-primary-500" />
                  {{ item }}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <!-- Security -->
      <section id="security" class="px-6 pb-20 scroll-mt-8">
        <div class="max-w-5xl mx-auto bg-surface-900 border border-surface-800 rounded-xl p-7">
          <div class="flex items-center gap-2 mb-4">
            <ShieldCheck class="w-[18px] h-[18px] text-primary-400" />
            <h2 class="text-base font-medium">{{ t('landing.securityTitle') }}</h2>
          </div>
          <ul class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
            <li
              v-for="item in messages('landing.security')"
              :key="item"
              class="flex items-start gap-2 text-xs text-surface-400 leading-relaxed"
            >
              <span class="shrink-0 mt-[6px] w-1 h-1 rounded-full bg-surface-500" />
              {{ item }}
            </li>
          </ul>
        </div>
      </section>

      <!-- Managed offer -->
      <section id="managed" class="px-6 pb-20 scroll-mt-8">
        <div
          class="max-w-5xl mx-auto border border-primary-500/30 bg-primary-600/5 rounded-xl p-7 flex flex-col md:flex-row md:items-center gap-6"
        >
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-3">
              <CloudCog class="w-[18px] h-[18px] text-primary-400" />
              <h2 class="text-base font-medium">{{ t('landing.managedTitle') }}</h2>
            </div>
            <p class="text-xs text-surface-400 leading-relaxed max-w-[70ch]">
              {{ t('landing.managedBody', { appName: branding.appName }) }}
            </p>
          </div>
          <div class="flex flex-col sm:flex-row md:flex-col gap-2 shrink-0">
            <a
              :href="MANAGED_URL"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-surface-700 text-surface-100 hover:bg-surface-900 transition-colors"
            >
              {{ t('landing.managedSite') }}
              <ArrowRight class="w-[13px] h-[13px]" />
            </a>
            <a
              :href="`mailto:${MANAGED_EMAIL}`"
              class="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs text-surface-400 hover:text-surface-100 transition-colors"
            >
              <Mail class="w-[13px] h-[13px]" />
              {{ MANAGED_EMAIL }}
            </a>
          </div>
        </div>
      </section>
    </main>

    <!-- Footer -->
    <footer class="border-t border-surface-800/60">
      <div class="px-6 py-5 max-w-7xl mx-auto flex items-center justify-between gap-4 flex-wrap">
        <div class="flex items-center gap-3 text-xs text-surface-500">
          <span>{{ t('landing.footerLicense') }}</span>
          <span class="text-surface-700">·</span>
          <a
            :href="VENDOR_URL"
            target="_blank"
            rel="noopener noreferrer"
            class="hover:text-surface-300 transition-colors"
          >
            {{ t('landing.footerRights') }}
          </a>
        </div>
        <a
          :href="GITHUB_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 text-xs text-surface-500 hover:text-surface-300 transition-colors"
        >
          <GithubIcon class="w-[13px] h-[13px]" />
          GitHub
        </a>
      </div>
    </footer>
  </div>
</template>
