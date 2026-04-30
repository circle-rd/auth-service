<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServicesStore } from '@/stores/services';
import { listUsers } from '@/api/users';
import { listApplications } from '@/api/applications';
import { listOrganizations } from '@/api/organizations';
import type { User } from '@/types';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import { CheckCircle, XCircle, CreditCard, ShieldCheck, Lock, Users, AppWindow, Building2 } from 'lucide-vue-next';

const { t } = useI18n();
const services = useServicesStore();

const users = ref<User[]>([]);
const appCount = ref(0);
const orgCount = ref(0);
const loading = ref(true);

onMounted(async () => {
  await Promise.all([
    services.fetch(),
    (async () => {
      const [u, a, o] = await Promise.all([listUsers({ limit: 200 }), listApplications(), listOrganizations()]);
      users.value = u.users;
      appCount.value = a.applications.length;
      orgCount.value = o.organizations.length;
    })(),
  ]);
  loading.value = false;
});

const mfaRate = computed(() => {
  if (!users.value.length) return 0;
  return Math.round((users.value.filter(u => u.twoFactorEnabled).length / users.value.length) * 100);
});

const mfaForcedCount = computed(() => users.value.filter(u => u.isMfaRequired).length);

const PROVIDERS = ['google', 'github', 'linkedin', 'microsoft', 'apple'] as const;

function maskId(id: string | undefined) {
  if (!id) return '';
  return id.slice(0, 6) + '••••••••' + id.slice(-4);
}

type ProviderKey = typeof PROVIDERS[number];

function getProvider(key: ProviderKey) {
  return services.config?.providers[key];
}
</script>

<template>
  <AppLayout :title="t('configuration.title')" :subtitle="t('configuration.subtitle')">
    <div class="space-y-6 max-w-3xl">
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <div class="px-5 py-4 border-b border-surface-700/40">
          <h2 class="text-sm font-semibold text-surface-200">{{ t('configuration.providers') }}</h2>
        </div>
        <div class="divide-y divide-surface-800/40">
          <div v-for="key in PROVIDERS" :key="key" class="px-5 py-4 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div :class="['w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold', getProvider(key)?.enabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-surface-800 text-surface-500']">
                {{ key[0].toUpperCase() }}
              </div>
              <div>
                <p class="text-sm font-medium text-surface-200 capitalize">{{ key }}</p>
                <p v-if="getProvider(key)?.enabled && getProvider(key)?.clientId" class="text-xs font-mono text-surface-500 mt-0.5">
                  {{ maskId(getProvider(key)?.clientId) }}
                </p>
              </div>
            </div>
            <BaseBadge :variant="getProvider(key)?.enabled ? 'success' : 'neutral'" dot>
              {{ getProvider(key)?.enabled ? t('common.enabled') : t('common.disabled') }}
            </BaseBadge>
          </div>
        </div>
      </div>

      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
        <div class="flex items-center gap-3 mb-3">
          <div class="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
            <CreditCard class="w-4 h-4 text-emerald-400" />
          </div>
          <h2 class="text-sm font-semibold text-surface-200">{{ t('configuration.billing') }}</h2>
        </div>
        <div v-if="loading" class="h-8 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-lg w-32" />
        <template v-else>
          <div class="flex items-center gap-2 mb-2">
            <CheckCircle v-if="services.config?.stripe" class="w-4 h-4 text-emerald-400" />
            <XCircle v-else class="w-4 h-4 text-surface-600" />
            <p class="text-sm font-medium" :class="services.config?.stripe ? 'text-emerald-400' : 'text-surface-400'">
              {{ services.config?.stripe ? t('configuration.stripeActive') : t('configuration.stripeInactive') }}
            </p>
          </div>
          <p v-if="!services.config?.stripe" class="text-xs text-surface-500">{{ t('configuration.stripeInactiveNote') }}</p>
        </template>
      </div>

      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center">
            <ShieldCheck class="w-4 h-4 text-primary-400" />
          </div>
          <h2 class="text-sm font-semibold text-surface-200">{{ t('configuration.mfa') }}</h2>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <p class="text-xs text-surface-500 mb-1">{{ t('configuration.mfaAdoption') }}</p>
            <p class="text-2xl font-bold text-surface-100">{{ mfaRate }}%</p>
            <div class="mt-2 h-1.5 bg-surface-800 rounded-full overflow-hidden">
              <div class="h-full bg-primary-500 rounded-full transition-all duration-500" :style="{ width: `${mfaRate}%` }" />
            </div>
          </div>
          <div>
            <p class="text-xs text-surface-500 mb-1">{{ t('configuration.mfaForced') }}</p>
            <p class="text-2xl font-bold text-surface-100">{{ mfaForcedCount }}</p>
          </div>
        </div>
      </div>

      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center">
            <Lock class="w-4 h-4 text-surface-400" />
          </div>
          <h2 class="text-sm font-semibold text-surface-200">{{ t('configuration.platformInfo') }}</h2>
        </div>
        <div class="grid grid-cols-3 gap-4">
          <div class="text-center">
            <div class="w-10 h-10 rounded-xl bg-primary-500/10 flex items-center justify-center mx-auto mb-2">
              <Users class="w-5 h-5 text-primary-400" />
            </div>
            <p class="text-xl font-bold text-surface-100">{{ users.length }}</p>
            <p class="text-xs text-surface-500">{{ t('nav.users') }}</p>
          </div>
          <div class="text-center">
            <div class="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center mx-auto mb-2">
              <AppWindow class="w-5 h-5 text-emerald-400" />
            </div>
            <p class="text-xl font-bold text-surface-100">{{ appCount }}</p>
            <p class="text-xs text-surface-500">{{ t('nav.applications') }}</p>
          </div>
          <div class="text-center">
            <div class="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center mx-auto mb-2">
              <Building2 class="w-5 h-5 text-amber-400" />
            </div>
            <p class="text-xl font-bold text-surface-100">{{ orgCount }}</p>
            <p class="text-xs text-surface-500">{{ t('nav.organizations') }}</p>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
