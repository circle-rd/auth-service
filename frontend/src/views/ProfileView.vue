<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { updateMyProfile } from '@/api/users';
import { listMySessions, revokeSession } from '@/api/sessions';
import { getMyConsumption } from '@/api/consumption';
import { getMyOrganizations } from '@/api/organizations';
import type { Session, ConsumptionAggregate } from '@/types';
import { useToast } from '@/composables/useToast';
import { parseUserAgent } from '@/composables/useUserAgent';
import ProfileLayout from '@/components/layout/ProfileLayout.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import { Monitor, CheckCircle, ShieldCheck, Key, Building2, Receipt } from 'lucide-vue-next';

interface SubscriptionPlanPrice {
  id: string
  planId: string
  name: string
  amount: string
  currency: string
  interval: 'month' | 'year' | 'one_time'
  stripePriceId: string | null
  createdAt: string
}

interface SubscriptionEntry {
  applicationId: string
  applicationName: string
  applicationSlug: string
  applicationIcon: string | null
  isActive: boolean
  plan: { id: string; name: string; description: string | null; features: Record<string, unknown>; isDefault: boolean | null; prices: SubscriptionPlanPrice[] } | null
}

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToast();

const activeTab = ref<'account' | 'security' | 'organizations' | 'applications'>('account');

const profileTabs = [
  { key: 'account' as const, label: t('profile.tabAccount') },
  { key: 'security' as const, label: t('profile.tabSecurity') },
  { key: 'organizations' as const, label: t('profile.tabOrganizations') },
  { key: 'applications' as const, label: t('profile.tabApplications') },
];

const sessions = ref<Session[]>([]);
const currentSessionId = ref<string>('');
const subscriptions = ref<SubscriptionEntry[]>([]);
const consumption = ref<Record<string, ConsumptionAggregate[]>>({});
const myOrgs = ref<Array<{ id: string; name: string; slug: string; logo: string | null; role: string }>>([]);
const saveLoading = ref(false);
const sessionsLoading = ref(true);
const appsLoading = ref(true);

const form = ref({
  name: '',
  phone: '',
  company: '',
  position: '',
  address: '',
  image: '',
});

// Populate form immediately from store — no API call needed
if (auth.user) {
  form.value = {
    name: auth.user.name,
    phone: auth.user.phone ?? '',
    company: auth.user.company ?? '',
    position: auth.user.position ?? '',
    address: auth.user.address ?? '',
    image: auth.user.image ?? '',
  };
}

onMounted(async () => {
  if (!auth.user) return;

  // Sessions — independent fetch, user-facing (no admin required)
  listMySessions()
    .then(res => {
      sessions.value = res.sessions;
      currentSessionId.value = res.currentSessionId;
    })
    .catch(() => { /* silently ignore */ })
    .finally(() => { sessionsLoading.value = false; });

  // User organizations — user-facing
  getMyOrganizations()
    .then(res => { myOrgs.value = res.organizations; })
    .catch(() => { /* silently ignore */ });

  // Subscriptions + consumption — user-facing endpoints
  fetch('/api/user/subscription', { credentials: 'include' })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(async (data: { subscriptions: SubscriptionEntry[] }) => {
      subscriptions.value = data.subscriptions;
      for (const sub of data.subscriptions) {
        try {
          const res = await getMyConsumption(sub.applicationId);
          consumption.value[sub.applicationId] = res.aggregates;
        } catch { /* silently ignore */ }
      }
    })
    .catch(() => { /* silently ignore */ })
    .finally(() => { appsLoading.value = false; });
});

async function handleSave() {
  if (!auth.user) return;
  saveLoading.value = true;
  try {
    await updateMyProfile({
      name: form.value.name,
      phone: form.value.phone || null,
      company: form.value.company || null,
      position: form.value.position || null,
      address: form.value.address || null,
      image: form.value.image || null,
    });
    // Also update the in-memory store so the header/avatar reflects the new name immediately
    if (auth.user) {
      auth.user.name = form.value.name;
      auth.user.image = form.value.image || null;
    }
    toast.success(t('profile.saved'));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to update');
  } finally {
    saveLoading.value = false;
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function formatPrice(amount: string, currency: string) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 2 }).format(Number(amount) / 100);
}

function isPlanFeatureMetered(v: unknown): v is { usage: true; limit: number; unit: string; pricePerUnit: number } {
  if (!v || typeof v !== 'object') return false;
  return (v as Record<string, unknown>).usage === true;
}

function getMyInvoice(sub: SubscriptionEntry): { baseAmount: number; usageLines: Array<{ key: string; unit: string; total: number; pricePerUnit: number; subtotal: number }>; total: number; currency: string } {
  if (!sub.plan) return { baseAmount: 0, usageLines: [], total: 0, currency: 'eur' };
  const monthlyPrice = (sub.plan.prices ?? []).find(p => p.interval === 'month');
  const baseAmount = monthlyPrice ? Number(monthlyPrice.amount) : 0;
  const currency = monthlyPrice?.currency ?? 'eur';
  const usageLines = Object.entries(sub.plan.features)
    .filter(([, v]) => isPlanFeatureMetered(v))
    .map(([key, v]) => {
      const feature = v as { usage: true; limit: number; unit: string; pricePerUnit: number };
      const agg = (consumption.value[sub.applicationId] ?? []).find(c => c.key === key);
      const total = agg ? Number(agg.total) : 0;
      return { key, unit: feature.unit, total, pricePerUnit: feature.pricePerUnit, subtotal: total * feature.pricePerUnit };
    });
  const usageTotal = usageLines.reduce((sum, l) => sum + l.subtotal, 0);
  return { baseAmount, usageLines, total: baseAmount + usageTotal, currency };
}

async function handleRevoke(session: Session) {
  try {
    await revokeSession(session.id);
    sessions.value = sessions.value.filter(s => s.id !== session.id);
    toast.success(t('profile.sessionRevoked'));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to revoke session');
  }
}
</script>

<template>
  <ProfileLayout>
    <!-- Profile hero -->
    <div class="flex items-center gap-4 mb-6">
      <UserAvatar :name="auth.user?.name" :image="auth.user?.image" size="lg" />
      <div class="flex-1 min-w-0">
        <h2 class="text-lg font-semibold text-surface-100">{{ auth.user?.name }}</h2>
        <p class="text-sm text-surface-500 mt-0.5 truncate">{{ auth.user?.email }}</p>
      </div>
    </div>

    <!-- Tab navigation -->
    <div class="flex gap-1 p-1 bg-surface-900/60 rounded-xl border border-surface-700/40 w-fit overflow-x-auto mb-6">
      <button
        v-for="tab in profileTabs"
        :key="tab.key"
        @click="activeTab = tab.key"
        :class="[
          'px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
          activeTab === tab.key
            ? 'bg-primary-600/20 text-primary-300 shadow-sm'
            : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/60',
        ]"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- Account tab -->
    <div v-if="activeTab === 'account'" class="space-y-5">
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-6">
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-4">{{ t('profile.personalInfo') }}</h3>
        <form @submit.prevent="handleSave" class="space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <BaseInput v-model="form.name" :label="t('profile.name')" required />
            <BaseInput v-model="form.phone" :label="t('profile.phone')" type="tel" />
          </div>
          <div class="grid grid-cols-2 gap-4">
            <BaseInput v-model="form.company" :label="t('profile.company')" />
            <BaseInput v-model="form.position" :label="t('profile.position')" />
          </div>
          <BaseInput v-model="form.address" :label="t('profile.address')" />
          <BaseInput v-model="form.image" :label="t('profile.avatar')" :hint="t('profile.emailChangeNote')" />
          <div class="flex justify-end">
            <BaseButton type="submit" :loading="saveLoading">{{ t('common.save') }}</BaseButton>
          </div>
        </form>
      </div>
    </div>

    <!-- Security tab -->
    <div v-if="activeTab === 'security'" class="space-y-5">
      <!-- 2FA + Passkeys -->
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-4">{{ t('profile.security') }}</h3>
        <div class="space-y-3">
          <div class="flex items-center justify-between py-3 border-b border-surface-800/40">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center">
                <ShieldCheck class="w-4 h-4 text-primary-400" />
              </div>
              <div>
                <p class="text-sm font-medium text-surface-200">{{ t('profile.totp') }}</p>
                <p class="text-xs text-surface-500 mt-0.5">{{ auth.user?.twoFactorEnabled ? t('profile.totpEnabled') : t('profile.totpDisabled') }}</p>
              </div>
            </div>
            <CheckCircle v-if="auth.user?.twoFactorEnabled" class="w-5 h-5 text-emerald-400" />
            <BaseBadge v-else variant="neutral">Not set</BaseBadge>
          </div>
          <div class="flex items-center justify-between py-3">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center">
                <Key class="w-4 h-4 text-surface-400" />
              </div>
              <div>
                <p class="text-sm font-medium text-surface-200">{{ t('profile.passkeys') }}</p>
                <p class="text-xs text-surface-500 mt-0.5">{{ t('profile.passkeysNote') }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Active sessions -->
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <div class="px-5 py-4 border-b border-surface-700/40">
          <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.activeSessions') }}</h3>
        </div>
        <div v-if="sessionsLoading" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.loading') }}</div>
        <div v-else-if="sessions.length === 0" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.noData') }}</div>
        <div v-else class="divide-y divide-surface-800/40">
          <div v-for="session in sessions" :key="session.id" class="px-5 py-4 flex items-center gap-4">
            <div class="w-8 h-8 rounded-lg bg-surface-800 flex items-center justify-center shrink-0">
              <Monitor class="w-4 h-4 text-surface-400" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <p class="text-sm text-surface-200">{{ parseUserAgent(session.userAgent).browser }} on {{ parseUserAgent(session.userAgent).os }}</p>
                <BaseBadge v-if="session.id === currentSessionId" variant="success" size="sm">{{ t('profile.current') }}</BaseBadge>
              </div>
              <p class="text-xs text-surface-500 mt-0.5">{{ session.ipAddress }} · {{ formatDate(session.createdAt) }}</p>
            </div>
            <BaseButton v-if="session.id !== currentSessionId" variant="ghost" size="sm" @click="handleRevoke(session)">{{ t('profile.revoke') }}</BaseButton>
          </div>
        </div>
      </div>
    </div>

    <!-- Organizations tab -->
    <div v-if="activeTab === 'organizations'" class="space-y-5">
      <div v-if="!myOrgs.length" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-10 text-center">
        <Building2 class="w-8 h-8 text-surface-600 mx-auto mb-3" />
        <p class="text-sm text-surface-500">{{ t('common.noData') }}</p>
      </div>
      <div v-else class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <div class="divide-y divide-surface-800/40">
          <div v-for="org in myOrgs" :key="org.id" class="px-5 py-3 flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg overflow-hidden shrink-0">
              <img v-if="org.logo" :src="org.logo" class="w-full h-full object-cover" />
              <div v-else class="w-full h-full bg-primary-600/20 flex items-center justify-center">
                <Building2 class="w-4 h-4 text-primary-400" />
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-surface-200">{{ org.name }}</p>
              <p class="text-xs text-surface-500 font-mono">{{ org.slug }}</p>
            </div>
            <BaseBadge :variant="org.role === 'owner' ? 'warning' : 'neutral'" size="sm">{{ org.role }}</BaseBadge>
          </div>
        </div>
      </div>
    </div>

    <!-- Applications tab -->
    <div v-if="activeTab === 'applications'" class="space-y-5">
      <!-- App subscriptions -->
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <div class="px-5 py-4 border-b border-surface-700/40">
          <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.appAccess') }}</h3>
        </div>
        <div v-if="appsLoading" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.loading') }}</div>
        <div v-else-if="!subscriptions.length" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.noData') }}</div>
        <div v-else class="divide-y divide-surface-800/40">
          <div v-for="sub in subscriptions" :key="sub.applicationId" class="px-5 py-4">
            <div class="flex items-center gap-3 mb-2">
              <img v-if="sub.applicationIcon" :src="sub.applicationIcon" class="w-5 h-5 rounded shrink-0" />
              <p class="text-sm font-medium text-surface-200 flex-1 truncate">{{ sub.applicationName }}</p>
              <BaseBadge :variant="sub.isActive ? 'success' : 'neutral'" size="sm" dot>{{ sub.isActive ? t('common.active') : t('common.inactive') }}</BaseBadge>
              <BaseBadge v-if="sub.plan" variant="neutral" size="sm">{{ sub.plan.name }}</BaseBadge>
            </div>
            <div v-if="consumption[sub.applicationId]?.length" class="flex flex-wrap gap-2 mt-2">
              <div v-for="agg in consumption[sub.applicationId]" :key="agg.key" class="px-2.5 py-1 rounded-lg bg-surface-800/60 border border-surface-700/30">
                <span class="text-xs font-mono text-surface-500">{{ agg.key }}: </span>
                <span class="text-xs font-semibold text-surface-200">{{ Number(agg.total).toLocaleString() }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Billing: per-app invoice estimates -->
      <div v-if="appsLoading || subscriptions.some(s => s.plan)" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <div class="px-5 py-4 border-b border-surface-700/40 flex items-center gap-2">
          <Receipt class="w-4 h-4 text-surface-400" />
          <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.billing') }}</h3>
        </div>
        <div v-if="appsLoading" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.loading') }}</div>
        <div v-else-if="!subscriptions.some(s => s.plan)" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('profile.noInvoices') }}</div>
        <div v-else class="divide-y divide-surface-800/40">
          <div v-for="sub in subscriptions.filter(s => s.plan)" :key="sub.applicationId">
            <!-- App header -->
            <div class="px-5 py-3 bg-surface-800/30 flex items-center gap-3">
              <img v-if="sub.applicationIcon" :src="sub.applicationIcon" class="w-5 h-5 rounded shrink-0" />
              <div class="flex-1 min-w-0">
                <span class="text-sm font-medium text-surface-200">{{ sub.applicationName }}</span>
                <span class="text-xs text-surface-500 ml-2">{{ sub.plan!.name }}</span>
              </div>
              <span class="text-sm font-semibold text-surface-100 tabular-nums">
                {{ formatPrice(String(getMyInvoice(sub).total), getMyInvoice(sub).currency) }}
              </span>
            </div>
            <!-- Line items -->
            <div class="divide-y divide-surface-800/40 text-sm">
              <div v-if="getMyInvoice(sub).baseAmount > 0" class="px-5 py-2.5 flex items-center justify-between">
                <span class="text-surface-400">{{ t('profile.basePrice') }}</span>
                <span class="text-surface-200 tabular-nums">{{ formatPrice(String(getMyInvoice(sub).baseAmount), getMyInvoice(sub).currency) }}</span>
              </div>
              <div v-for="line in getMyInvoice(sub).usageLines" :key="line.key" class="px-5 py-2.5 flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <code class="text-xs font-mono text-surface-500 bg-surface-800/50 px-1.5 py-0.5 rounded">{{ line.key }}</code>
                  <span class="text-surface-500">{{ line.total.toLocaleString() }} {{ line.unit }} × {{ formatPrice(String(line.pricePerUnit), getMyInvoice(sub).currency) }}</span>
                </div>
                <span class="text-surface-200 tabular-nums">{{ formatPrice(String(line.subtotal), getMyInvoice(sub).currency) }}</span>
              </div>
              <div class="px-5 py-3 flex items-center justify-between bg-surface-800/20">
                <span class="text-sm font-medium text-surface-200">{{ t('profile.totalEstimate') }}</span>
                <span class="text-base font-bold text-surface-100 tabular-nums">{{ formatPrice(String(getMyInvoice(sub).total), getMyInvoice(sub).currency) }}</span>
              </div>
            </div>
          </div>
        </div>
        <!-- History placeholder -->
        <div class="border-t border-surface-700/40 p-6 text-center">
          <Receipt class="w-7 h-7 text-surface-600 mx-auto mb-2" />
          <p class="text-sm font-medium text-surface-500">{{ t('profile.invoiceHistoryPlaceholder') }}</p>
          <p class="text-xs text-surface-600 mt-1">{{ t('profile.invoiceHistoryNote') }}</p>
        </div>
      </div>
    </div>
  </ProfileLayout>
</template>
