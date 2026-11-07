<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { updateMyProfile, type UpdateMyProfileBody } from '@/api/users';
import { listMySessions, revokeSession } from '@/api/sessions';
import { getMyConsumption } from '@/api/consumption';
import { getMyOrganizations } from '@/api/organizations';
import { getMySubscriptions, changeMyPlan } from '@/api/subscriptions';
import { getMyMfaState } from '@/api/passkeys';
import type { Session, ConsumptionAggregate, UserSubscriptionEntry, UserSubscriptionPlan, MfaState } from '@/types';
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
import PasskeySettings from '@/components/profile/PasskeySettings.vue';
import AvatarModal from '@/components/profile/AvatarModal.vue';
import WalletPanel from '@/components/profile/WalletPanel.vue';
import BillingPanel from '@/components/profile/BillingPanel.vue';
import { Monitor, ShieldCheck, ShieldAlert, Building2, RefreshCw, Lock, CreditCard, ExternalLink, Pencil, CalendarDays, AppWindow } from '@lucide/vue';
import type { SelectOption } from '@/types/select';
import { countryDefaults, countryFlag, countryName, countryOptions } from '@/utils/countries';

const { t, locale } = useI18n();

/** Only http(s) application URLs are rendered as links (never javascript:). */
function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const auth = useAuthStore();
const toast = useToast();

const route = useRoute();
// A payment provider return lands on the credit tab.
type ProfileTabKey = 'account' | 'security' | 'organizations' | 'applications' | 'credit';
const activeTab = ref<ProfileTabKey>(
  route.query.topup !== undefined ? 'credit' : 'account',
);

const profileTabs = [
  { key: 'account' as const, label: t('profile.tabAccount') },
  { key: 'security' as const, label: t('profile.tabSecurity') },
  { key: 'organizations' as const, label: t('profile.tabOrganizations') },
  { key: 'applications' as const, label: t('profile.tabApplications') },
  { key: 'credit' as const, label: t('profile.tabCredit') },
];

const profileTabOptions = computed<SelectOption[]>(() =>
  profileTabs.map((tab) => ({ value: tab.key, label: tab.label })),
);

function setActiveTab(value: string) {
  activeTab.value = value as ProfileTabKey;
}

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
  firstName: '',
  lastName: '',
  username: '',
  phone: '',
  company: '',
  position: '',
  address: '',
  postalCode: '',
  city: '',
  region: '',
  country: '',
  middleName: '',
  profileUrl: '',
  website: '',
  gender: '',
  birthdate: '',
  zoneinfo: '',
  locale: '',
});

const initialForm = ref<typeof form.value | null>(null);

const genderOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('profile.notSet') },
  { value: 'female', label: t('profile.genderFemale') },
  { value: 'male', label: t('profile.genderMale') },
  { value: 'other', label: t('profile.genderOther') },
]);

function setGender(value: string) {
  form.value.gender = value;
}

// ── Form hydration and safe prefill ─────────────────────────────────────────
// Values coming from a social provider or an earlier edit are never replaced:
// the helpers below only fill a field that is empty, or one that still holds
// the value this page generated itself.
const showAvatarModal = ref(false);
const accountTab = ref<'identity' | 'oidc'>('identity');

let syncingName = false;
const lastAutoName = ref('');
const lastAutoFirst = ref('');
const lastAutoLast = ref('');
const lastAutoLocale = ref('');
const lastAutoZoneinfo = ref('');

const countrySelectOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('profile.notSet') },
  ...countryOptions(locale.value),
]);

const userCountryLabel = computed(() =>
  auth.user?.country
    ? `${countryFlag(auth.user.country)} ${countryName(auth.user.country, locale.value)}`
    : null,
);

const oidcItems = computed(() => [
  { label: t('profile.middleName'), filled: form.value.middleName.trim().length > 0 },
  { label: t('profile.profileUrl'), filled: form.value.profileUrl.trim().length > 0 },
  { label: t('profile.website'), filled: form.value.website.trim().length > 0 },
  { label: t('profile.gender'), filled: form.value.gender.trim().length > 0 },
  { label: t('profile.birthdate'), filled: form.value.birthdate.trim().length > 0 },
  { label: t('profile.zoneinfo'), filled: form.value.zoneinfo.trim().length > 0 },
  { label: t('profile.locale'), filled: form.value.locale.trim().length > 0 },
  { label: t('profile.avatarModalTitle'), filled: Boolean(auth.user?.image) },
]);

const filledOidcCount = computed(() => oidcItems.value.filter((item) => item.filled).length);
const missingOidcFields = computed(() =>
  oidcItems.value.filter((item) => !item.filled).map((item) => item.label),
);

function populateForm(user: NonNullable<typeof auth.user>) {
  syncingName = true;
  form.value = {
    name: user.name,
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? '',
    username: user.username ?? '',
    phone: user.phone ?? '',
    company: user.company ?? '',
    position: user.position ?? '',
    address: user.address ?? '',
    postalCode: user.postalCode ?? '',
    city: user.city ?? '',
    region: user.region ?? '',
    country: user.country ? user.country.toUpperCase() : '',
    middleName: user.middleName ?? '',
    profileUrl: user.profileUrl ?? '',
    website: user.website ?? '',
    gender: user.gender ?? '',
    birthdate: user.birthdate ?? '',
    zoneinfo: user.zoneinfo ?? '',
    locale: user.locale ?? '',
  };
  void nextTick(() => {
    syncingName = false;
  });
}

function splitFullName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
  };
}

function combinedName(): string {
  return [form.value.firstName.trim(), form.value.lastName.trim()]
    .filter(Boolean)
    .join(' ');
}

function applyInitialPrefills() {
  lastAutoName.value = '';
  lastAutoFirst.value = '';
  lastAutoLast.value = '';
  lastAutoLocale.value = '';
  lastAutoZoneinfo.value = '';

  const name = form.value.name.trim();
  const combined = combinedName();
  if (!name && combined) {
    form.value.name = combined;
    lastAutoName.value = combined;
  } else if (name && !form.value.firstName.trim() && !form.value.lastName.trim()) {
    const parts = splitFullName(name);
    form.value.firstName = parts.firstName;
    form.value.lastName = parts.lastName;
    lastAutoFirst.value = parts.firstName;
    lastAutoLast.value = parts.lastName;
  } else if (name && combined && name === combined) {
    lastAutoName.value = name;
  }

  const defaults = countryDefaults(form.value.country);
  if (defaults) {
    if (!form.value.locale.trim()) {
      form.value.locale = defaults.locale;
      lastAutoLocale.value = defaults.locale;
    }
    if (!form.value.zoneinfo.trim()) {
      form.value.zoneinfo = defaults.timezone;
      lastAutoZoneinfo.value = defaults.timezone;
    }
  }
}

if (auth.user) {
  populateForm(auth.user);
  initialForm.value = { ...form.value };
  applyInitialPrefills();
}

watch(
  () => auth.user,
  (user) => {
    if (!user) return;
    populateForm(user);
    initialForm.value = { ...form.value };
    applyInitialPrefills();
  },
);

watch(
  () => [form.value.firstName, form.value.lastName],
  () => {
    if (syncingName) return;
    const combined = combinedName();
    if (!combined) return;
    if (!form.value.name.trim() || form.value.name === lastAutoName.value) {
      syncingName = true;
      form.value.name = combined;
      lastAutoName.value = combined;
      void nextTick(() => {
        syncingName = false;
      });
    }
  },
);

watch(
  () => form.value.name,
  (name) => {
    if (syncingName) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const parts = splitFullName(trimmed);
    const canFillFirst =
      !form.value.firstName.trim() ||
      form.value.firstName === lastAutoFirst.value;
    const canFillLast =
      !form.value.lastName.trim() ||
      form.value.lastName === lastAutoLast.value;
    if (!canFillFirst && !canFillLast) {
      lastAutoName.value = '';
      return;
    }
    syncingName = true;
    if (canFillFirst) {
      form.value.firstName = parts.firstName;
      lastAutoFirst.value = parts.firstName;
    }
    if (canFillLast) {
      form.value.lastName = parts.lastName;
      lastAutoLast.value = parts.lastName;
    }
    lastAutoName.value = trimmed;
    void nextTick(() => {
      syncingName = false;
    });
  },
);

watch(
  () => form.value.country,
  (country) => {
    const defaults = countryDefaults(country);
    if (!defaults) return;
    if (!form.value.locale.trim() || form.value.locale === lastAutoLocale.value) {
      form.value.locale = defaults.locale;
      lastAutoLocale.value = defaults.locale;
    }
    if (!form.value.zoneinfo.trim() || form.value.zoneinfo === lastAutoZoneinfo.value) {
      form.value.zoneinfo = defaults.timezone;
      lastAutoZoneinfo.value = defaults.timezone;
    }
  },
);

function setCountry(value: string) {
  form.value.country = value;
}

function handleAvatarSaved(image: string | null) {
  if (auth.user) auth.user.image = image;
}

onMounted(async () => {
  if (!auth.user) return;

  // MFA state is derived from the actual factors, not from the cached
  // `twoFactorEnabled` flag (which is also true for passkey-only accounts).
  loadMfaState();

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

type ProfileFormKey = keyof typeof form.value;

function normalizedField(key: ProfileFormKey): string | null {
  const value = form.value[key].trim();
  if (key === 'name') return value;
  if (key === 'country') return value ? value.toUpperCase() : null;
  if (key === 'gender') return value || null;
  return value || null;
}

/** Only send fields the user actually changed: a background social-provider
 *  update must not be clobbered by a stale full-form submit. */
function buildProfilePatch(): UpdateMyProfileBody {
  const patch: UpdateMyProfileBody = {};
  const baseline = initialForm.value;
  if (!baseline) return patch;
  for (const key of Object.keys(form.value) as ProfileFormKey[]) {
    const current = normalizedField(key);
    const initial = normalizedFieldFrom(key, baseline);
    if (current === initial) continue;
    if (key === 'name' && !current) continue;
    (patch as Record<string, unknown>)[key] = current;
  }
  return patch;
}

function normalizedFieldFrom(
  key: ProfileFormKey,
  source: typeof form.value,
): string | null {
  const value = source[key].trim();
  if (key === 'name') return value;
  if (key === 'country') return value ? value.toUpperCase() : null;
  if (key === 'gender') return value || null;
  return value || null;
}

async function handleSave() {
  if (!auth.user) return;
  const patch = buildProfilePatch();
  saveLoading.value = true;
  try {
    if (Object.keys(patch).length > 0) {
      await updateMyProfile(patch);
      if (auth.user) Object.assign(auth.user, patch);
      initialForm.value = { ...form.value };
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

function formatDateShort(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
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
const myMfa = ref<MfaState>({
  mfaEnabled: false,
  methods: [],
  totpRegistered: false,
  passkeyCount: 0,
  backupCodesAvailable: false,
});

async function loadMfaState(): Promise<void> {
  try {
    myMfa.value = await getMyMfaState();
  } catch {
    // The security panel keeps its last known state; the TOTP row must never
    // infer TOTP from `twoFactorEnabled`, which can also mean passkey-only.
  }
}

async function handleMfaChanged(): Promise<void> {
  showSetupMfa.value = false;
  showDisableMfa.value = false;
  await Promise.all([loadMfaState(), auth.fetchSession()]);
}

async function handlePasskeyChanged(): Promise<void> {
  await Promise.all([loadMfaState(), auth.fetchSession()]);
}

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
    <template #identity>
      <div class="p-5 sm:p-6 lg:p-8 flex items-center gap-4 lg:flex-col lg:items-start">
        <button
          type="button"
          class="group relative rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60"
          :aria-label="t('profile.avatarEdit')"
          :title="t('profile.avatarEdit')"
          @click="showAvatarModal = true"
        >
          <UserAvatar :name="auth.user?.name" :image="auth.user?.image" size="xl" />
          <span class="absolute inset-0 rounded-full bg-black/45 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity flex items-center justify-center">
            <Pencil class="w-5 h-5 text-white" />
          </span>
        </button>
        <div class="min-w-0 flex-1 lg:w-full">
          <h2 class="text-lg font-semibold text-surface-100 truncate">{{ auth.user?.name }}</h2>
          <p class="text-sm text-surface-500 mt-0.5 truncate">{{ auth.user?.email }}</p>
          <div class="flex flex-wrap gap-1.5 mt-3">
            <BaseBadge v-if="auth.user?.role" variant="neutral" size="sm" class="capitalize">{{ auth.user.role }}</BaseBadge>
            <BaseBadge v-if="myMfa.totpRegistered" variant="success" size="sm" dot>MFA</BaseBadge>
            <BaseBadge v-if="userCountryLabel" variant="neutral" size="sm">{{ userCountryLabel }}</BaseBadge>
          </div>
          <dl class="hidden lg:block mt-6 pt-5 border-t border-surface-800/60 space-y-3 text-sm">
            <div class="flex items-center gap-2 text-surface-400">
              <CalendarDays class="w-4 h-4 text-surface-500" />
              <span>{{ t('profile.memberSince') }}</span>
              <span class="ml-auto text-surface-300">{{ auth.user ? formatDateShort(auth.user.createdAt) : '—' }}</span>
            </div>
            <div class="flex items-center gap-2 text-surface-400">
              <Building2 class="w-4 h-4 text-surface-500" />
              <span>{{ t('profile.organizations') }}</span>
              <span class="ml-auto text-surface-300">{{ myOrgs.length }}</span>
            </div>
            <div class="flex items-center gap-2 text-surface-400">
              <AppWindow class="w-4 h-4 text-surface-500" />
              <span>{{ t('profile.appAccess') }}</span>
              <span class="ml-auto text-surface-300">{{ subscriptions.length }}</span>
            </div>
          </dl>
        </div>
      </div>
    </template>

    <!-- Tab navigation: compact selector on mobile, pills on wider screens -->
    <div class="sm:hidden mb-6">
      <BaseSelect
        :model-value="activeTab"
        :options="profileTabOptions"
        @update:model-value="setActiveTab"
      />
    </div>
    <div class="hidden sm:flex gap-1 p-1 bg-surface-900/60 rounded-xl border border-surface-700/40 overflow-x-auto mb-6 scroll-smooth">
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

    <!-- Account tab: standard identity first, optional OIDC claims second -->
    <div v-if="activeTab === 'account'" class="space-y-5">
      <div class="grid grid-cols-2 gap-1 p-1 bg-surface-900/60 rounded-xl border border-surface-700/40 sm:flex sm:w-fit">
        <button
          type="button"
          :class="[
            'px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150',
            accountTab === 'identity'
              ? 'bg-primary-600/20 text-primary-300 shadow-sm'
              : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/60',
          ]"
          @click="accountTab = 'identity'"
        >
          {{ t('profile.identityView') }}
        </button>
        <button
          type="button"
          :class="[
            'px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150',
            accountTab === 'oidc'
              ? 'bg-primary-600/20 text-primary-300 shadow-sm'
              : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/60',
          ]"
          @click="accountTab = 'oidc'"
        >
          {{ t('profile.oidcView') }}
        </button>
      </div>

      <form @submit.prevent="handleSave" class="space-y-5">
        <div v-if="accountTab === 'identity'" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-4 sm:p-6">
          <div class="mb-4">
            <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.personalInfo') }}</h3>
            <p class="text-xs text-surface-500 mt-1">{{ t('profile.identityViewHint') }}</p>
          </div>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <BaseInput v-model="form.firstName" :label="t('profile.firstName')" class="sm:col-span-2" />
            <BaseInput v-model="form.lastName" :label="t('profile.lastName')" class="sm:col-span-2" />
            <BaseInput v-model="form.name" :label="t('profile.name')" required class="sm:col-span-2" />
            <BaseInput v-model="form.username" :label="t('profile.username')" class="sm:col-span-3" />
            <BaseInput v-model="form.phone" :label="t('profile.phone')" type="tel" class="sm:col-span-3" />
            <BaseInput v-model="form.company" :label="t('profile.company')" class="sm:col-span-3" />
            <BaseInput v-model="form.position" :label="t('profile.position')" class="sm:col-span-3" />
            <BaseInput v-model="form.address" :label="t('profile.address')" class="sm:col-span-6" />
            <BaseInput v-model="form.postalCode" :label="t('profile.postalCode')" class="sm:col-span-2" />
            <BaseInput v-model="form.city" :label="t('profile.city')" class="sm:col-span-4" />
            <BaseInput v-model="form.region" :label="t('profile.region')" class="sm:col-span-3" />
            <BaseSelect
              :model-value="form.country"
              :label="t('profile.country')"
              :options="countrySelectOptions"
              class="sm:col-span-3"
              @update:model-value="setCountry"
            />
          </div>
        </div>

        <div v-else class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-4 sm:p-6">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">{{ t('profile.oidcView') }}</h3>
              <p class="text-xs text-surface-500 mt-1">{{ t('profile.oidcViewHint') }}</p>
            </div>
            <BaseBadge :variant="missingOidcFields.length ? 'warning' : 'success'" size="sm">
              {{ t('profile.oidcIncomplete', { filled: filledOidcCount, total: oidcItems.length }) }}
            </BaseBadge>
          </div>
          <div class="mt-4 h-1.5 rounded-full bg-surface-800 overflow-hidden">
            <div class="h-full bg-primary-500 transition-all" :style="{ width: `${(filledOidcCount / oidcItems.length) * 100}%` }" />
          </div>
          <div v-if="missingOidcFields.length" class="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
            <p class="text-xs font-medium text-amber-200">{{ t('profile.oidcMissing') }}</p>
            <p class="text-xs text-amber-200/80 mt-1">{{ missingOidcFields.join(' · ') }}</p>
          </div>
          <p v-else class="mt-4 text-xs text-emerald-300">{{ t('profile.oidcAllSet') }}</p>

          <div class="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <BaseInput v-model="form.middleName" :label="t('profile.middleName')" />
            <BaseInput v-model="form.profileUrl" :label="t('profile.profileUrl')" type="url" placeholder="https://example.com/users/me" />
            <BaseInput v-model="form.website" :label="t('profile.website')" type="url" placeholder="https://example.com" />
            <BaseSelect
              :model-value="form.gender"
              :label="t('profile.gender')"
              :options="genderOptions"
              @update:model-value="setGender"
            />
            <BaseInput v-model="form.birthdate" :label="t('profile.birthdate')" :hint="t('profile.birthdateHint')" placeholder="1990-01-31" />
            <BaseInput v-model="form.zoneinfo" :label="t('profile.zoneinfo')" :hint="t('profile.zoneinfoHint')" placeholder="Europe/Paris" />
            <BaseInput v-model="form.locale" :label="t('profile.locale')" :hint="t('profile.localeHint')" placeholder="fr-FR" />
          </div>
        </div>

        <div class="flex justify-end">
          <BaseButton type="submit" :loading="saveLoading">{{ t('common.save') }}</BaseButton>
        </div>
      </form>
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
      <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-4 sm:p-5">
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-4">{{ t('profile.security') }}</h3>
        <div class="space-y-3">
          <div class="flex flex-col gap-3 py-3 border-b border-surface-800/40 sm:flex-row sm:items-center sm:justify-between">
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

          <div class="flex flex-col gap-3 py-3 border-b border-surface-800/40 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center shrink-0">
                <ShieldCheck class="w-4 h-4 text-primary-400" />
              </div>
              <div class="min-w-0">
                <p class="text-sm font-medium text-surface-200">{{ t('mfa.totp.title') }}</p>
                <p class="text-xs text-surface-500 mt-0.5">
                  {{ myMfa.totpRegistered ? t('mfa.totp.enabledDesc') : t('mfa.totp.disabledDesc') }}
                </p>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <template v-if="myMfa.totpRegistered">
                <BaseBadge variant="success" size="sm" dot>{{ t('common.enabled') }}</BaseBadge>
                <BaseButton variant="danger-outline" size="sm" @click="showDisableMfa = true">
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
          <div v-if="myMfa.totpRegistered" class="flex flex-col gap-3 py-3 border-b border-surface-800/40 sm:flex-row sm:items-center sm:justify-between">
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

          <!-- Passkeys are an independent MFA method -->
          <div class="pt-3 border-t border-surface-800/40">
            <PasskeySettings @changed="handlePasskeyChanged" />
          </div>
        </div>
      </div>

      <!-- MFA modals -->
      <MfaSetupModal :open="showSetupMfa" @close="showSetupMfa = false" @success="handleMfaChanged" />
      <MfaDisableModal :open="showDisableMfa" @close="showDisableMfa = false" @success="handleMfaChanged" />
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
          <div v-for="session in sessions" :key="session.id" class="px-4 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
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
          <div v-for="org in myOrgs" :key="org.id" class="px-4 py-3 flex items-center gap-3 sm:px-5">
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
          <div v-for="sub in subscriptions" :key="sub.applicationId" class="px-4 py-4 sm:px-5">
            <div class="flex flex-wrap items-center gap-2 mb-2 sm:gap-3">
              <div class="flex items-center gap-2 min-w-0 w-full sm:flex-1">
                <img v-if="sub.applicationIcon" :src="sub.applicationIcon" class="w-5 h-5 rounded shrink-0" />
                <a
                  v-if="isHttpUrl(sub.applicationUrl)"
                  :href="sub.applicationUrl || undefined"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="group inline-flex items-center gap-1.5 min-w-0 flex-1 text-sm font-medium text-surface-200 hover:text-primary-300 transition-colors"
                  :title="sub.applicationUrl || undefined"
                >
                  <span class="truncate">{{ sub.applicationName }}</span>
                  <ExternalLink class="w-3.5 h-3.5 shrink-0 opacity-50 group-hover:opacity-100" />
                </a>
                <p v-else class="text-sm font-medium text-surface-200 flex-1 truncate">{{ sub.applicationName }}</p>
              </div>
              <div class="flex flex-wrap items-center gap-2 w-full sm:w-auto">
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

    <AvatarModal
      :open="showAvatarModal"
      :name="auth.user?.name"
      :email="auth.user?.email"
      :image="auth.user?.image"
      @close="showAvatarModal = false"
      @saved="handleAvatarSaved"
    />
  </ProfileLayout>
</template>
