<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { updateMyProfile } from '@/api/users';
import { listMySessions, revokeSession } from '@/api/sessions';
import { getMyConsumption } from '@/api/consumption';
import type { Session, ConsumptionAggregate } from '@/types';
import { useToast } from '@/composables/useToast';
import { parseUserAgent } from '@/composables/useUserAgent';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import { Monitor, CheckCircle, ShieldCheck, Key } from 'lucide-vue-next';

interface SubscriptionEntry {
  applicationId: string
  applicationName: string
  applicationSlug: string
  applicationIcon: string | null
  isActive: boolean
  plan: { id: string; name: string; description: string | null; features: Record<string, unknown>; isDefault: boolean | null } | null
}

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToast();

const sessions = ref<Session[]>([]);
const currentSessionId = ref<string>('');
const subscriptions = ref<SubscriptionEntry[]>([]);
const consumption = ref<Record<string, ConsumptionAggregate[]>>({});
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
  <AppLayout :title="t('profile.title')" :subtitle="t('profile.subtitle')">
    <div class="space-y-6 max-w-2xl">
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-6">
        <div class="flex items-center gap-4 mb-6">
          <UserAvatar :name="auth.user?.name" :image="auth.user?.image" size="lg" />
          <div>
            <h2 class="text-base font-semibold text-surface-100">{{ auth.user?.name }}</h2>
            <p class="text-sm text-surface-500">{{ auth.user?.email }}</p>
          </div>
        </div>

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

      <div v-if="appsLoading || subscriptions.length" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <div class="px-5 py-4 border-b border-surface-700/40">
          <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.appAccess') }}</h3>
        </div>
        <div v-if="appsLoading" class="px-5 py-6 text-center text-sm text-surface-500">{{ t('common.loading') }}</div>
        <div v-else class="divide-y divide-surface-800/40">
          <div v-for="sub in subscriptions" :key="sub.applicationId" class="px-5 py-4">
            <div class="flex items-center gap-3 mb-2">
              <img v-if="sub.applicationIcon" :src="sub.applicationIcon" class="w-5 h-5 rounded" />
              <p class="text-sm font-medium text-surface-200 flex-1">{{ sub.applicationName }}</p>
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
    </div>
  </AppLayout>
</template>
