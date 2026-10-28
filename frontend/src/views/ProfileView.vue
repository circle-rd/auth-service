<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { updateMyProfile } from '@/api/users';
import { listMySessions, revokeSession } from '@/api/sessions';
import { getMyConsumption } from '@/api/consumption';
import { getMyOrganizations } from '@/api/organizations';
import { getMySubscriptions, changeMyPlan } from '@/api/subscriptions';
import type { Session, ConsumptionAggregate, UserSubscriptionEntry, UserSubscriptionPlan } from '@/types';
import { useToast } from '@/composables/useToast';
import { parseUserAgent } from '@/composables/useUserAgent';
import ProfileLayout from '@/components/layout/ProfileLayout.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import MfaSetupModal from '@/components/profile/MfaSetupModal.vue';
import MfaDisableModal from '@/components/profile/MfaDisableModal.vue';
import MfaBackupCodesModal from '@/components/profile/MfaBackupCodesModal.vue';
import ChangePasswordModal from '@/components/profile/ChangePasswordModal.vue';
import WalletPanel from '@/components/profile/WalletPanel.vue';
import BillingPanel from '@/components/profile/BillingPanel.vue';
import { Monitor, ShieldCheck, ShieldAlert, Key, Building2, RefreshCw, Lock, CreditCard } from 'lucide-vue-next';
import type { SelectOption } from '@/types/select';

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToast();

const route = useRoute();
// A payment provider return lands on the credit tab.
const activeTab = ref<'account' | 'security' | 'organizations' | 'applications' | 'credit'>(
  route.query.topup !== undefined ? 'credit' : 'account',
);

const profileTabs = [
  { key: 'account' as const, label: t('profile.tabAccount') },
  { key: 'security' as const, label: t('profile.tabSecurity') },
  { key: 'organizations' as const, label: t('profile.tabOrganizations') },
  { key: 'applications' as const, label: t('profile.tabApplications') },
  { key: 'credit' as const, label: t('profile.tabCredit') },
];

const sessions = ref<Session[]>([]);
const currentSessionId = ref<string>('');
const subscriptions = ref<UserSubscriptionEntry[]>([]);
const stripeConfigured = ref(false);
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
  getMySubscriptions()
    .then(async (data) => {
      subscriptions.value = data.subscriptions;
      stripeConfigured.value = data.stripeConfigured;
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

async function handleRevoke(session: Session) {
  try {
    await revokeSession(session.id);
    sessions.value = sessions.value.filter(s => s.id !== session.id);
    toast.success(t('profile.sessionRevoked'));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to revoke session');
  }
}

// ── MFA modal state ────────────────────────────────────────────────────────
const showSetupMfa = ref(false);
const showDisableMfa = ref(false);
const showRegenerateBackup = ref(false);

// ── Password modal state ───────────────────────────────────────────────────
const showChangePassword = ref(false);

// ── Subscription change modal state ────────────────────────────────────────
const showPlanModal = ref(false);
const planTarget = ref<UserSubscriptionEntry | null>(null);
const planForm = ref({ planId: '' });
const planSaving = ref(false);

/** The plan's recurring price, for the picker: "Free" when nothing is charged. */
function planPriceLabel(plan: UserSubscriptionPlan): string {
  const recurring = plan.prices.find((p) => p.interval !== 'one_time');
  if (!recurring || Number(recurring.amount) === 0) return t('profile.planFree');
  return `${formatPrice(recurring.amount, recurring.currency)} / ${recurring.interval}`;
}

const planOptions = computed<SelectOption[]>(() =>
  (planTarget.value?.availablePlans ?? []).map((p) => ({
    value: p.id,
    label: p.name,
    description: planPriceLabel(p),
    icon: CreditCard,
  })),
);

function openPlanModal(sub: UserSubscriptionEntry) {
  planTarget.value = sub;
  planForm.value = { planId: sub.plan?.id ?? sub.availablePlans[0]?.id ?? '' };
  showPlanModal.value = true;
}

async function handleChangePlan() {
  if (!planTarget.value || !planForm.value.planId || planSaving.value) return;
  planSaving.value = true;
  try {
    const result = await changeMyPlan(planTarget.value.applicationId, planForm.value.planId);
    if (result.checkoutUrl) {
      // A paid plan is bought on Stripe's page; the plan is granted when it completes.
      window.location.assign(result.checkoutUrl);
      return;
    }
    const data = await getMySubscriptions();
    subscriptions.value = data.subscriptions;
    stripeConfigured.value = data.stripeConfigured;
    toast.success(t(result.pending ? 'profile.planChangePending' : 'profile.planChangeSuccess'));
    showPlanModal.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('common.error'));
  } finally {
    planSaving.value = false;
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
    <div class="flex gap-1 p-1 bg-surface-900/60 rounded-xl border border-surface-700/40 overflow-x-auto -mx-6 sm:mx-0 px-6 sm:px-0 mb-6 scroll-smooth snap-x snap-mandatory">
      <button
        v-for="tab in profileTabs"
        :key="tab.key"
        @click="activeTab = tab.key"
        :class="[
          'px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap snap-start',
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
      <!-- MFA setup-required banner -->
      <div
        v-if="auth.mfaSetupRequired"
        class="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-4 flex items-start gap-3"
      >
        <ShieldAlert class="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div class="flex-1">
          <p class="text-sm font-medium text-amber-200">{{ t('mfa.banner.requiredTitle') }}</p>
          <p class="text-xs text-amber-200/80 mt-0.5">{{ t('mfa.banner.requiredBody') }}</p>
        </div>
        <BaseButton variant="primary" size="sm" @click="showSetupMfa = true">
          {{ t('mfa.banner.requiredAction') }}
        </BaseButton>
      </div>

      <!-- TOTP authenticator -->
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-4">{{ t('profile.security') }}</h3>
        <div class="space-y-3">
          <div class="flex items-center justify-between gap-4 py-3 border-b border-surface-800/40">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center shrink-0">
                <Lock class="w-4 h-4 text-primary-400" />
              </div>
              <div class="min-w-0">
                <p class="text-sm font-medium text-surface-200">{{ t('profile.changePassword') }}</p>
                <p class="text-xs text-surface-500 mt-0.5">{{ t('profile.changePasswordDesc') }}</p>
              </div>
            </div>
            <BaseButton variant="outline" size="sm" @click="showChangePassword = true">
              {{ t('profile.changePasswordAction') }}
            </BaseButton>
          </div>

          <div class="flex items-center justify-between gap-4 py-3 border-b border-surface-800/40">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center shrink-0">
                <ShieldCheck class="w-4 h-4 text-primary-400" />
              </div>
              <div class="min-w-0">
                <p class="text-sm font-medium text-surface-200">{{ t('mfa.totp.title') }}</p>
                <p class="text-xs text-surface-500 mt-0.5">
                  {{ auth.user?.twoFactorEnabled ? t('mfa.totp.enabledDesc') : t('mfa.totp.disabledDesc') }}
                </p>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <template v-if="auth.user?.twoFactorEnabled">
                <BaseBadge variant="success" size="sm" dot>{{ t('common.enabled') }}</BaseBadge>
                <BaseButton variant="outline" size="sm" @click="showDisableMfa = true">
                  {{ t('mfa.totp.disable') }}
                </BaseButton>
              </template>
              <template v-else>
                <BaseBadge variant="neutral" size="sm">{{ t('common.disabled') }}</BaseBadge>
                <BaseButton variant="primary" size="sm" @click="showSetupMfa = true">
                  {{ t('mfa.totp.enable') }}
                </BaseButton>
              </template>
            </div>
          </div>

          <!-- Backup codes — visible only when TOTP is enabled -->
          <div v-if="auth.user?.twoFactorEnabled" class="flex items-center justify-between gap-4 py-3 border-b border-surface-800/40">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center shrink-0">
                <RefreshCw class="w-4 h-4 text-surface-400" />
              </div>
              <div class="min-w-0">
                <p class="text-sm font-medium text-surface-200">{{ t('mfa.backupCodes.label') }}</p>
                <p class="text-xs text-surface-500 mt-0.5">{{ t('mfa.backupCodes.cardDesc') }}</p>
              </div>
            </div>
            <BaseButton variant="outline" size="sm" @click="showRegenerateBackup = true">
              {{ t('mfa.backupCodes.regenerateAction') }}
            </BaseButton>
          </div>

          <!-- Passkeys — Phase 2 -->
          <div class="flex items-center justify-between gap-4 py-3">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center shrink-0">
                <Key class="w-4 h-4 text-surface-400" />
              </div>
              <div class="min-w-0">
                <p class="text-sm font-medium text-surface-200">{{ t('profile.passkeys') }}</p>
                <p class="text-xs text-surface-500 mt-0.5">{{ t('mfa.passkeys.comingSoonDesc') }}</p>
              </div>
            </div>
            <BaseBadge variant="neutral" size="sm">{{ t('mfa.passkeys.comingSoon') }}</BaseBadge>
          </div>
        </div>
      </div>

      <!-- MFA modals -->
      <MfaSetupModal :open="showSetupMfa" @close="showSetupMfa = false" @success="showSetupMfa = false" />
      <MfaDisableModal :open="showDisableMfa" @close="showDisableMfa = false" @success="showDisableMfa = false" />
      <MfaBackupCodesModal :open="showRegenerateBackup" @close="showRegenerateBackup = false" />
      <ChangePasswordModal :open="showChangePassword" @close="showChangePassword = false" @success="showChangePassword = false" />

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

    <!-- Credit tab -->
    <WalletPanel v-if="activeTab === 'credit'" />

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
              <BaseButton
                v-if="stripeConfigured && sub.availablePlans.length > 0"
                size="sm"
                variant="outline"
                @click="openPlanModal(sub)"
              >
                <CreditCard class="w-3.5 h-3.5" />{{ t('profile.changePlan') }}
              </BaseButton>
            </div>
            <p v-if="!stripeConfigured && sub.availablePlans.length > 0" class="text-xs text-surface-500">{{ t('profile.manageByAdmin') }}</p>
            <div v-if="consumption[sub.applicationId]?.length" class="flex flex-wrap gap-2 mt-2">
              <div v-for="agg in consumption[sub.applicationId]" :key="agg.key" class="px-2.5 py-1 rounded-lg bg-surface-800/60 border border-surface-700/30">
                <span class="text-xs font-mono text-surface-500">{{ agg.key }}: </span>
                <span class="text-xs font-semibold text-surface-200">{{ Number(agg.total).toLocaleString() }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Billing: metered usage and real invoices -->
      <BillingPanel :subscriptions="subscriptions" :loading="appsLoading" />
    </div>
    <!-- Self-service plan change (only when Stripe is configured) -->
    <BaseModal :open="showPlanModal" :title="t('profile.changePlanTitle')" @close="showPlanModal = false">
      <div class="space-y-4">
        <p class="text-sm text-surface-400">{{ t('profile.changePlanHint', { app: planTarget?.applicationName ?? '' }) }}</p>
        <BaseSelect v-model="planForm.planId" :label="t('appDetail.subscriptionPlan')" :options="planOptions" />
        <p class="text-xs text-surface-500">{{ t('profile.changePlanPaidNote') }}</p>
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showPlanModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="planSaving" :disabled="!planForm.planId" @click="handleChangePlan">{{ t('profile.changePlan') }}</BaseButton>
      </template>
    </BaseModal>
  </ProfileLayout>
</template>
