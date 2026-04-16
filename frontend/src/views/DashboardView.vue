<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useServicesStore } from '@/stores/services';
import { listUsers } from '@/api/users';
import { listSessions, revokeSession } from '@/api/sessions';
import { listApplications } from '@/api/applications';
import { listOrganizations } from '@/api/organizations';
import AppLayout from '@/components/layout/AppLayout.vue';
import StatCard from '@/components/ui/StatCard.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { parseUserAgent } from '@/composables/useUserAgent';
import type { Session, User, Application, Organization } from '@/types';
import {
  Users, MonitorSmartphone, AppWindow, Building2,
  AlertTriangle, Info, UserPlus, Plus, Settings, Clock,
} from 'lucide-vue-next';
import { Line } from 'vue-chartjs';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler } from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

const { t, d } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const services = useServicesStore();

const users = ref<User[]>([]);
const sessions = ref<Session[]>([]);
const applications = ref<Application[]>([]);
const organizations = ref<Organization[]>([]);
const loading = ref(true);
const timeRange = ref<'7d' | '30d'>('7d');
const lastRefreshed = ref(new Date());

onMounted(async () => {
  await Promise.all([
    services.fetch(),
    (async () => {
      const [u, s, a, o] = await Promise.all([
        listUsers({ limit: 100 }),
        listSessions({ limit: 100 }),
        listApplications(),
        listOrganizations(),
      ]);
      users.value = u.users;
      sessions.value = s.sessions;
      applications.value = a.applications;
      organizations.value = o.organizations;
      lastRefreshed.value = new Date();
    })(),
  ]);
  loading.value = false;
});

const activeApplications = computed(() => applications.value.filter(a => a.isActive).length);

const userMap = computed(() => {
  const m = new Map<string, User>();
  users.value.forEach(u => m.set(u.id, u));
  return m;
});

function generateDateLabels(days: number): string[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  });
}

function generateUserRegistrationData(days: number) {
  const counts = Array(days).fill(0);
  const now = new Date();
  users.value.forEach(u => {
    const diff = Math.floor((now.getTime() - new Date(u.createdAt).getTime()) / 86400000);
    if (diff < days) counts[days - 1 - diff]++;
  });
  return counts;
}

const chartDays = computed(() => timeRange.value === '7d' ? 7 : 30);

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false }, tooltip: { mode: 'index' as const, intersect: false } },
  scales: {
    x: { grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { color: '#64748b', font: { size: 11 } } },
    y: { grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { color: '#64748b', font: { size: 11 }, stepSize: 1 }, beginAtZero: true },
  },
};

const userChartData = computed(() => ({
  labels: generateDateLabels(chartDays.value),
  datasets: [{
    data: generateUserRegistrationData(chartDays.value),
    borderColor: '#3b82f6',
    backgroundColor: 'rgba(59,130,246,0.08)',
    fill: true,
    tension: 0.4,
    pointRadius: 3,
    pointBackgroundColor: '#3b82f6',
  }],
}));

const hasNoProviders = computed(() => {
  const p = services.config?.providers;
  if (!p) return false;
  return !Object.values(p).some(v => v.enabled);
});

const hasNoMfa = computed(() => !users.value.some(u => u.twoFactorEnabled || u.isMfaRequired));

async function handleRevoke(session: Session) {
  await revokeSession(session.id);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

void d;
</script>

<template>
  <AppLayout :title="t('dashboard.title')" :subtitle="t('dashboard.subtitle')">
    <div class="space-y-6">
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard :label="t('dashboard.totalUsers')" :value="loading ? '' : users.length" :loading="loading" :icon="Users" />
        <StatCard :label="t('dashboard.activeSessions')" :value="loading ? '' : sessions.length" :loading="loading" :icon="MonitorSmartphone" :sub="t('dashboard.lastRefreshed') + ' ' + lastRefreshed.toLocaleTimeString()" />
        <StatCard :label="t('dashboard.totalApplications')" :value="loading ? '' : applications.length" :loading="loading" :icon="AppWindow" :sub="`${activeApplications} ${t('common.active')}`" />
        <StatCard :label="t('dashboard.totalOrganizations')" :value="loading ? '' : organizations.length" :loading="loading" :icon="Building2" />
      </div>

      <div v-if="services.config && !loading" class="space-y-2">
        <div v-if="!services.config.stripe" class="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/8 border border-amber-500/20 text-amber-300">
          <AlertTriangle class="w-4 h-4 mt-0.5 shrink-0" />
          <p class="text-sm">{{ t('dashboard.stripeDisabled') }}</p>
        </div>
        <div v-if="hasNoProviders" class="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-500/8 border border-red-500/20 text-red-300">
          <AlertTriangle class="w-4 h-4 mt-0.5 shrink-0" />
          <p class="text-sm">{{ t('dashboard.noProviders') }}</p>
        </div>
        <div v-if="hasNoMfa" class="flex items-start gap-3 px-4 py-3 rounded-xl bg-sky-500/8 border border-sky-500/20 text-sky-300">
          <Info class="w-4 h-4 mt-0.5 shrink-0" />
          <p class="text-sm">{{ t('dashboard.noMfaEnforced') }}</p>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div class="lg:col-span-2 rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
          <div class="flex items-center justify-between mb-4">
            <p class="text-sm font-semibold text-surface-200">{{ t('dashboard.newRegistrations') }}</p>
            <div class="flex gap-1">
              <button
                v-for="r in (['7d', '30d'] as const)"
                :key="r"
                @click="timeRange = r"
                :class="['px-2.5 py-1 rounded-lg text-xs font-medium transition-colors', timeRange === r ? 'bg-primary-600/20 text-primary-300' : 'text-surface-500 hover:text-surface-300']"
              >
                {{ t(`dashboard.timeRanges.${r}`) }}
              </button>
            </div>
          </div>
          <div class="h-48">
            <Line v-if="!loading" :data="userChartData" :options="chartOptions" />
            <div v-else class="h-full bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-xl" />
          </div>
        </div>

        <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
          <p class="text-sm font-semibold text-surface-200 mb-4">{{ t('dashboard.quickActions') }}</p>
          <div class="space-y-2">
            <button @click="router.push('/users')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-800/60 transition-colors text-left">
              <div class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center shrink-0">
                <UserPlus class="w-4 h-4 text-primary-400" />
              </div>
              {{ t('dashboard.createUser') }}
            </button>
            <button @click="router.push('/applications')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-800/60 transition-colors text-left">
              <div class="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                <Plus class="w-4 h-4 text-emerald-400" />
              </div>
              {{ t('dashboard.createApplication') }}
            </button>
            <button @click="router.push('/configuration')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-800/60 transition-colors text-left">
              <div class="w-8 h-8 rounded-lg bg-surface-700/60 flex items-center justify-center shrink-0">
                <Settings class="w-4 h-4 text-surface-400" />
              </div>
              {{ t('dashboard.goToConfiguration') }}
            </button>
          </div>
        </div>
      </div>

      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <div class="px-5 py-4 border-b border-surface-700/40 flex items-center justify-between">
          <p class="text-sm font-semibold text-surface-200">{{ t('dashboard.activeSessionsList') }}</p>
          <span class="text-xs text-surface-500">{{ sessions.length }} {{ t('common.total').toLowerCase() }}</span>
        </div>

        <div v-if="loading" class="divide-y divide-surface-800/40">
          <div v-for="i in 3" :key="i" class="px-5 py-4 flex items-center gap-4">
            <div class="w-9 h-9 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-full" />
            <div class="flex-1 space-y-2">
              <div class="h-3.5 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded w-32" />
              <div class="h-3 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded w-48" />
            </div>
          </div>
        </div>

        <div v-else-if="sessions.length === 0" class="px-5 py-10 text-center text-sm text-surface-500">
          No active sessions
        </div>

        <div v-else class="divide-y divide-surface-800/40">
          <div
            v-for="session in sessions"
            :key="session.id"
            class="px-5 py-4 flex items-center gap-4 hover:bg-surface-800/20 transition-colors"
          >
            <UserAvatar
              :name="userMap.get(session.userId)?.name"
              :image="userMap.get(session.userId)?.image"
              size="sm"
            />
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-surface-200">
                {{ userMap.get(session.userId)?.name ?? t('common.unknown') }}
                <span v-if="session.userId === auth.user?.id" class="ml-2 text-xs text-primary-400">(you)</span>
              </p>
              <p class="text-xs text-surface-500 mt-0.5">
                {{ userMap.get(session.userId)?.email }} · {{ session.ipAddress ?? '—' }} ·
                {{ parseUserAgent(session.userAgent).browser }} / {{ parseUserAgent(session.userAgent).os }}
              </p>
            </div>
            <div class="text-right shrink-0 hidden sm:block">
              <p class="text-xs text-surface-400 flex items-center gap-1">
                <Clock class="w-3 h-3" />
                {{ formatDate(session.createdAt) }}
              </p>
              <p class="text-xs text-surface-600 mt-0.5">Expires {{ formatDate(session.expiresAt) }}</p>
            </div>
            <BaseButton variant="ghost" size="sm" @click="handleRevoke(session)">{{ t('dashboard.revoke') }}</BaseButton>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
