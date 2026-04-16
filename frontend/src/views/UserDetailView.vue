<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { getUser } from '@/api/users';
import { getUserConsumption } from '@/api/consumption';
import { listApplications } from '@/api/applications';
import type { User, UserApplication, ConsumptionAggregate, Application } from '@/types';
import AppLayout from '@/components/layout/AppLayout.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { ArrowLeft, CheckCircle, XCircle, Shield, ShieldAlert } from 'lucide-vue-next';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const user = ref<User | null>(null);
const userApps = ref<UserApplication[]>([]);
const applications = ref<Application[]>([]);
const consumption = ref<Record<string, ConsumptionAggregate[]>>({});
const loading = ref(true);

const userId = route.params.id as string;

onMounted(async () => {
  try {
    const [userRes, appsRes] = await Promise.all([
      getUser(userId),
      listApplications(),
    ]);
    user.value = userRes.user;
    userApps.value = userRes.applications;
    applications.value = appsRes.applications;

    for (const ua of userRes.applications) {
      const res = await getUserConsumption(ua.userId, ua.applicationId);
      consumption.value[ua.applicationId] = res.aggregates;
    }
  } finally {
    loading.value = false;
  }
});

function getAppName(appId: string) {
  return applications.value.find(a => a.id === appId)?.name ?? appId;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function roleBadgeVariant(role: string | null) {
  if (role === 'superadmin') return 'error' as const;
  if (role === 'admin') return 'warning' as const;
  return 'neutral' as const;
}
</script>

<template>
  <AppLayout :title="user?.name ?? 'User Detail'" :subtitle="user?.email">
    <div class="space-y-6">
      <div>
        <BaseButton variant="ghost" size="sm" @click="router.back()">
          <ArrowLeft class="w-4 h-4" />
          {{ t('common.back') }}
        </BaseButton>
      </div>

      <div v-if="loading" class="space-y-4">
        <div v-for="i in 3" :key="i" class="h-32 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-2xl" />
      </div>

      <template v-else-if="user">
        <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-6">
          <div class="flex items-start gap-5">
            <UserAvatar :name="user.name" :image="user.image" size="lg" />
            <div class="flex-1">
              <div class="flex items-center gap-3 flex-wrap">
                <h2 class="text-lg font-semibold text-surface-100">{{ user.name }}</h2>
                <BaseBadge :variant="roleBadgeVariant(user.role)">
                  <ShieldAlert v-if="user.role === 'superadmin'" class="w-3 h-3" />
                  <Shield v-else-if="user.role === 'admin'" class="w-3 h-3" />
                  {{ user.role ? t(`users.${user.role}`) : t('users.user') }}
                </BaseBadge>
                <BaseBadge v-if="user.banned" variant="error" dot>{{ t('users.banned') }}</BaseBadge>
              </div>
              <p class="text-sm text-surface-400 mt-1">{{ user.email }}</p>
              <div class="flex flex-wrap gap-4 mt-3">
                <div class="flex items-center gap-1.5 text-xs text-surface-500">
                  <CheckCircle v-if="user.emailVerified" class="w-3.5 h-3.5 text-emerald-400" />
                  <XCircle v-else class="w-3.5 h-3.5 text-surface-600" />
                  {{ t('users.verified') }}
                </div>
                <div class="flex items-center gap-1.5 text-xs text-surface-500">
                  <CheckCircle v-if="user.twoFactorEnabled" class="w-3.5 h-3.5 text-emerald-400" />
                  <XCircle v-else class="w-3.5 h-3.5 text-surface-600" />
                  {{ t('users.mfa') }}
                </div>
              </div>
            </div>
          </div>

          <div class="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-4 pt-5 border-t border-surface-700/40">
            <div v-for="[key, val] in [['phone', user.phone], ['company', user.company], ['position', user.position], ['address', user.address]]" :key="(key as string)">
              <p class="text-xs font-medium text-surface-500 uppercase tracking-wide mb-1">{{ t(`profile.${key}`) }}</p>
              <p class="text-sm text-surface-300">{{ val ?? '—' }}</p>
            </div>
            <div>
              <p class="text-xs font-medium text-surface-500 uppercase tracking-wide mb-1">{{ t('users.createdAt') }}</p>
              <p class="text-sm text-surface-300">{{ formatDate(user.createdAt) }}</p>
            </div>
          </div>

          <div v-if="user.banned" class="mt-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
            <p class="text-sm font-medium text-red-400 mb-1">{{ t('users.banReason') }}: {{ user.banReason }}</p>
            <p v-if="user.banExpires" class="text-xs text-red-400/70">{{ t('users.banExpires') }}: {{ formatDate(user.banExpires) }}</p>
          </div>
        </div>

        <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
          <div class="px-5 py-4 border-b border-surface-700/40">
            <h3 class="text-sm font-semibold text-surface-200">{{ t('users.applications') }}</h3>
          </div>
          <div v-if="userApps.length === 0" class="px-5 py-8 text-center text-sm text-surface-500">
            No application access
          </div>
          <div v-else class="divide-y divide-surface-800/40">
            <div v-for="ua in userApps" :key="ua.applicationId" class="px-5 py-4">
              <div class="flex items-start justify-between">
                <div>
                  <p class="text-sm font-medium text-surface-200">{{ getAppName(ua.applicationId) }}</p>
                  <div class="flex items-center gap-2 mt-1">
                    <BaseBadge :variant="ua.isActive ? 'success' : 'neutral'" size="sm" dot>{{ ua.isActive ? t('common.active') : t('common.inactive') }}</BaseBadge>
                    <span v-if="ua.roleId" class="text-xs text-surface-500">Role: {{ ua.roleId }}</span>
                  </div>
                </div>
              </div>
              <div v-if="consumption[ua.applicationId]?.length" class="mt-3 flex flex-wrap gap-3">
                <div
                  v-for="agg in consumption[ua.applicationId]"
                  :key="agg.key"
                  class="px-3 py-1.5 rounded-lg bg-surface-800/60 border border-surface-700/30"
                >
                  <p class="text-xs text-surface-500 font-mono">{{ agg.key }}</p>
                  <p class="text-sm font-semibold text-surface-200 tabular-nums">{{ Number(agg.total).toLocaleString() }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </AppLayout>
</template>
