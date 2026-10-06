<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { getUser, sendVerificationEmail, markEmailVerified } from '@/api/users';
import { getUserConsumption } from '@/api/consumption';
import { useToast } from '@/composables/useToast';
import { useAppBranding } from '@/composables/useAppBranding';
import { useAuthStore } from '@/stores/auth';
import type { User, UserApplicationDetail, ConsumptionAggregate } from '@/types';
import type { ColumnDef } from '@/types/data-table';
import AppLayout from '@/components/layout/AppLayout.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import DataTable from '@/components/ui/DataTable.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { ArrowLeft, CheckCircle, XCircle, Shield, ShieldAlert, Mail, MailCheck, KeyRound } from 'lucide-vue-next';
import SetPasswordModal from '@/components/users/SetPasswordModal.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const toast = useToast();
const auth = useAuthStore();
const { emailVerificationEnabled } = useAppBranding();

const user = ref<User | null>(null);
const userApps = ref<UserApplicationDetail[]>([]);
const consumption = ref<Record<string, ConsumptionAggregate[]>>({});
const loading = ref(true);
const actionLoading = ref(false);
const showSetPassword = ref(false);

const userId = route.params.id as string;

async function reloadUser(): Promise<void> {
  const res = await getUser(userId);
  user.value = res.user;
  userApps.value = res.applications;
}

async function handleResendVerification(): Promise<void> {
  actionLoading.value = true;
  try {
    await sendVerificationEmail(userId);
    // The endpoint reverts the account to unverified before sending.
    await reloadUser();
    toast.success(t('users.verificationSent'));
  } catch (err) {
    toast.error(
      err instanceof Error ? err.message : t('users.verificationSendError'),
    );
  } finally {
    actionLoading.value = false;
  }
}

async function handleMarkVerified(): Promise<void> {
  actionLoading.value = true;
  try {
    await markEmailVerified(userId);
    await reloadUser();
    toast.success(t('users.markedVerified'));
  } catch (err) {
    toast.error(
      err instanceof Error ? err.message : t('users.markVerifiedError'),
    );
  } finally {
    actionLoading.value = false;
  }
}

onMounted(async () => {
  try {
    const userRes = await getUser(userId);
    user.value = userRes.user;
    userApps.value = userRes.applications;

    for (const ua of userRes.applications) {
      try {
        const res = await getUserConsumption(userId, ua.id);
        consumption.value[ua.id] = res.aggregates;
      } catch {
        consumption.value[ua.id] = [];
      }
    }
  } finally {
    loading.value = false;
  }
});

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatLastLogin(iso: string | null | undefined): string {
  if (!iso) return t('users.never');
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatConsumption(aggs: ConsumptionAggregate[] | undefined): string {
  if (!aggs || aggs.length === 0) return '—';
  return aggs.map(a => `${a.key}: ${Number(a.total).toLocaleString()}`).join(' · ');
}

function roleBadgeVariant(role: string | null) {
  if (role === 'superadmin') return 'error' as const;
  if (role === 'admin') return 'warning' as const;
  return 'neutral' as const;
}

const appColumns = computed<ColumnDef<UserApplicationDetail>[]>(() => [
  { key: 'app', label: t('users.columns.applications') },
  { key: 'roles', label: t('users.columns.role'), responsive: 'sm' },
  { key: 'plan', label: 'Plan', responsive: 'md' },
  { key: 'status', label: 'Status', responsive: 'md' },
  { key: 'lastLogin', label: t('users.columns.lastLogin'), field: 'lastLoginAt', sortable: true, responsive: 'md' },
  { key: 'consumption', label: t('appDetail.consumption'), responsive: 'lg' },
]);
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
          <div class="flex flex-col sm:flex-row sm:items-start gap-4 sm:gap-5">
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

          <div
            v-if="emailVerificationEnabled && user && auth.canManageUser(user.role)"
            class="mt-5 flex flex-wrap gap-2"
          >
            <BaseButton
              variant="outline"
              size="sm"
              :loading="actionLoading"
              @click="handleResendVerification"
            >
              <Mail class="w-4 h-4" />
              {{ t('users.resendVerification') }}
            </BaseButton>
            <BaseButton
              v-if="!user.emailVerified"
              variant="outline"
              size="sm"
              :disabled="actionLoading"
              @click="handleMarkVerified"
            >
              <MailCheck class="w-4 h-4" />
              {{ t('users.markVerified') }}
            </BaseButton>
          </div>

          <!--
            Password reset. Guarded by the STRICT policy (`canManageRole`), not by
            `canManageUser`: the server refuses a reset against a peer, so a
            superadmin must not be shown this action on another superadmin.
          -->
          <div
            v-if="user && auth.canManageRole(user.role)"
            class="mt-5 flex flex-wrap gap-2"
          >
            <BaseButton
              variant="outline"
              size="sm"
              :disabled="actionLoading"
              @click="showSetPassword = true"
            >
              <KeyRound class="w-4 h-4" />
              {{ t('users.setPassword') }}
            </BaseButton>
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
          <div class="p-3">
            <DataTable
              :columns="appColumns"
              :items="userApps"
              :empty="userApps.length === 0"
              :row-key="(ua: UserApplicationDetail) => ua.id"
            >
              <template #empty>
                <EmptyState :title="t('users.applications')" :message="t('applications.noApps')" />
              </template>
              <template #cell-app="{ row }">
                <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-lg overflow-hidden shrink-0 bg-surface-800 flex items-center justify-center">
                    <img v-if="(row as UserApplicationDetail).icon" :src="(row as UserApplicationDetail).icon!" class="w-full h-full object-cover" />
                    <span v-else class="text-xs font-bold text-surface-400">{{ (row as UserApplicationDetail).name[0].toUpperCase() }}</span>
                  </div>
                  <div class="min-w-0">
                    <p class="text-sm font-medium text-surface-200 truncate">{{ (row as UserApplicationDetail).name }}</p>
                    <p class="text-xs text-surface-500 truncate">{{ (row as UserApplicationDetail).slug }}</p>
                  </div>
                </div>
              </template>
              <template #cell-roles="{ row }">
                <div class="flex flex-wrap gap-1">
                  <BaseBadge
                    v-for="r in (row as UserApplicationDetail).roles"
                    :key="r.id"
                    variant="neutral"
                    size="sm"
                  >{{ r.name }}</BaseBadge>
                  <span v-if="(row as UserApplicationDetail).roles.length === 0" class="text-xs text-surface-500">—</span>
                </div>
              </template>
              <template #cell-plan="{ row }">
                <span class="text-xs text-surface-400">{{ (row as UserApplicationDetail).subscriptionPlanName ?? (row as UserApplicationDetail).subscriptionPlanId ?? '—' }}</span>
              </template>
              <template #cell-status="{ row }">
                <BaseBadge :variant="(row as UserApplicationDetail).isActive ? 'success' : 'neutral'" size="sm" dot>
                  {{ (row as UserApplicationDetail).isActive ? t('common.active') : t('common.inactive') }}
                </BaseBadge>
              </template>
              <template #cell-lastLogin="{ row }">
                <span class="text-xs text-surface-400">{{ formatLastLogin((row as UserApplicationDetail).lastLoginAt) }}</span>
              </template>
              <template #cell-consumption="{ row }">
                <span class="text-xs text-surface-500 font-mono">{{ formatConsumption(consumption[(row as UserApplicationDetail).id]) }}</span>
              </template>
            </DataTable>
          </div>
        </div>
      </template>
    </div>
    <SetPasswordModal
      :open="showSetPassword"
      :user-id="userId"
      @close="showSetPassword = false"
      @success="reloadUser"
    />
  </AppLayout>
</template>
