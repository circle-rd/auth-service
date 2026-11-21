<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useServicesStore } from '@/stores/services';
import { useAppBranding } from '@/composables/useAppBranding';
import * as appsApi from '@/api/applications';
import * as consumptionApi from '@/api/consumption';
import { listUsers } from '@/api/users';
import { listOrganizations } from '@/api/organizations';
import { useToast } from '@/composables/useToast';
import { useRealtimeEvents } from '@/composables/useRealtimeEvents';
import { rotateSecret } from '@/api/applications';
import type { Application, AppRole, AppPermission, SubscriptionPlan, UserApplication, ConsumptionAggregate } from '@/types';
import type { AppSubscriptionRow } from '@/api/applications';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import SearchSelect from '@/components/ui/SearchSelect.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import CopyField from '@/components/ui/CopyField.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import DataTable from '@/components/ui/DataTable.vue';
import UserAppHistoryModal from '@/components/users/UserAppHistoryModal.vue';
import RolesPermissionsTab from '@/components/applications/RolesPermissionsTab.vue';
import PlanEditorModal from '@/components/applications/PlanEditorModal.vue';
import PlanPricesDialog from '@/components/applications/PlanPricesDialog.vue';
import { formatMinorAmount } from '@/utils/money';
import ApplicationInvitationsTab from '@/components/applications/ApplicationInvitationsTab.vue';
import ApplicationConsumptionTab from '@/components/applications/ApplicationConsumptionTab.vue';
import ApplicationFinancialTab from '@/components/applications/ApplicationFinancialTab.vue';
import ApplicationIntegrationTab from '@/components/applications/ApplicationIntegrationTab.vue';
import AppSharingSettings from '@/views/share/AppSharingSettings.vue';
import { parseUserAgent } from '@/composables/useUserAgent';
import Sparkline from '@/components/ui/Sparkline.vue';
import { getApplicationsActivity, getLogins, type AppActivityEntry } from '@/api/stats';
import type { ColumnDef, DataTablePagination } from '@/types/data-table';
import { usePersistentPageSize } from '@/composables/usePersistentPageSize';
import { useDebounce } from '@/composables/useDebounce';
import { ArrowLeft, Plus, Trash2, AlertTriangle, TrendingUp, History, Activity, Users, CreditCard, Building2, Shield, Ban, Star, Mail } from '@lucide/vue';
import type { SelectOption } from '@/types/select';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const toast = useToast();
const services = useServicesStore();
const { resourceSharing } = useAppBranding();

const appId = route.params.id as string;
const authServiceUrl = computed(() => window.location.origin);
type AppTabKey = 'roles' | 'users' | 'sharing' | 'plans' | 'invitations' | 'integration' | 'consumption' | 'financial';
const activeTab = ref<AppTabKey>('roles');
const invitationsTabRef = ref<InstanceType<typeof ApplicationInvitationsTab> | null>(null);

const app = ref<Application | null>(null);
const roles = ref<AppRole[]>([]);
const permissions = ref<AppPermission[]>([]);
const appUsers = ref<UserApplication[]>([]);
const appUsersTotal = ref(0);
const appUsersPage = ref(1);
const appUsersPageSize = usePersistentPageSize(`app-users:${appId}`, 20);
const appUsersSearch = ref('');
const debouncedAppUsersSearch = useDebounce(appUsersSearch, 300);
const plans = ref<SubscriptionPlan[]>([]);
const consumption = ref<ConsumptionAggregate[]>([]);
const appSubscriptions = ref<AppSubscriptionRow[]>([]);
const loading = ref(true);

const showUserModal = ref(false);
const showBulkUserModal = ref(false);
const planEditor = ref<{ open: boolean; plan: SubscriptionPlan | null }>({ open: false, plan: null });
const pricesPlan = ref<SubscriptionPlan | null>(null);
const showDeletePlanConfirm = ref(false);
const showRotateConfirm = ref(false);
const showSecretModal = ref(false);
const showDeleteUserConfirm = ref(false);
const showResetMetricConfirm = ref(false);
const showManageUserPlanModal = ref(false);

const formLoading = ref(false);
const managePlanLoading = ref(false);
const newSecret = ref('');
const selectedPlanId = ref<string | null>(null);
const selectedUserId = ref<string | null>(null);
const selectedMetric = ref<{ userId: string; key: string } | null>(null);

const userForm = ref({ userId: '', roleId: '', subscriptionPlanId: '' });
const bulkForm = ref({ organizationId: '', roleId: '', subscriptionPlanId: '' });
const managePlanForm = ref({ userId: '', planId: '', reason: '' });

const planOptions = computed<SelectOption[]>(() =>
  plans.value.map((p) => ({ value: p.id, label: p.name, description: p.description ?? undefined, icon: CreditCard })),
);

const defaultPlanSelectOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('appDetail.defaultPlanOption'), icon: Star },
  ...planOptions.value,
]);

const noPlanSelectOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('appDetail.noPlan'), icon: Ban },
  ...planOptions.value,
]);

// A `subscription.changed` frame refreshes the users tab; a `login.recorded`
// frame refreshes the last-login columns (date/IP/device) and the activity
// strip. The composable coalesces a burst into a single refresh.
const events = useRealtimeEvents(
  {
    'subscription.changed': () => {
      void reloadUsers();
      refreshAnalytics();
    },
    'login.recorded': () => {
      void reloadUsers();
      void loadAppActivity();
      // If the history modal is open, re-read it in place.
      if (historyModalOpen.value) historyRefreshKey.value += 1;
    },
    'presence.changed': () => void loadAppActivity(),
  },
  {
    onResync: () => {
      void reloadUsers();
      void loadAppActivity();
      refreshAnalytics();
    },
  },
);

onMounted(async () => {
  await services.fetch();
  await loadAll();
  void loadAppActivity();
});

onUnmounted(() => {
  events.close();
});

async function reloadUsers() {
  const res = await appsApi.listAppUsers(appId, {
    page: appUsersPage.value,
    limit: appUsersPageSize.value,
    search: debouncedAppUsersSearch.value || undefined,
  });
  if (res.users.length === 0 && appUsersPage.value > 1 && res.total > 0) {
    appUsersPage.value -= 1;
    return reloadUsers();
  }
  appUsers.value = res.users;
  appUsersTotal.value = res.total;
}

async function loadAll() {
  loading.value = true;
  try {
    const [appRes, rolesRes, permsRes, usersRes, plansRes] = await Promise.all([
      appsApi.getApplication(appId),
      appsApi.listRoles(appId),
      appsApi.listPermissions(appId),
      appsApi.listAppUsers(appId, {
        page: appUsersPage.value,
        limit: appUsersPageSize.value,
        search: debouncedAppUsersSearch.value || undefined,
      }),
      appsApi.listPlans(appId),
      listUsers({ limit: 200 }),
    ]);
    app.value = appRes.application;
    roles.value = rolesRes.roles;
    permissions.value = permsRes.permissions;
    appUsers.value = usersRes.users;
    appUsersTotal.value = usersRes.total;
    plans.value = plansRes.plans;
  } finally {
    loading.value = false;
  }
}

async function loadConsumption() {
  const res = await consumptionApi.getAppConsumption(appId);
  consumption.value = res.entries.map((entry) => ({
    userId: entry.userId,
    applicationId: appId,
    key: entry.key,
    total: entry.total,
    updatedAt: entry.updatedAt,
    userName: entry.userName,
    userEmail: entry.userEmail,
    subscriptionPlanId: entry.subscriptionPlanId,
  }));
}

async function loadSubscriptions() {
  appSubscriptions.value = (await appsApi.getAppSubscriptions(appId)).subscriptions;
}

function refreshAnalytics(): void {
  if (activeTab.value === 'financial' || appSubscriptions.value.length > 0) {
    void loadSubscriptions();
  }
  if (activeTab.value === 'consumption' || consumption.value.length > 0) {
    void loadConsumption();
  }
}

watch(activeTab, (tab) => {
  if (tab === 'consumption' && consumption.value.length === 0) void loadConsumption();
  if (tab === 'financial') {
    if (appSubscriptions.value.length === 0) void loadSubscriptions();
    if (consumption.value.length === 0) void loadConsumption();
  }
});

watch(appUsersPageSize, () => {
  appUsersPage.value = 1;
  void reloadUsers();
});

watch(debouncedAppUsersSearch, () => {
  appUsersPage.value = 1;
  void reloadUsers();
});

function onAppUsersPageChange(next: number) {
  appUsersPage.value = next;
  void reloadUsers();
}

function onAppUsersLimitChange(next: number) {
  appUsersPageSize.value = next;
}

const appUsersPagination = computed<DataTablePagination>(() => ({
  page: appUsersPage.value,
  limit: appUsersPageSize.value,
  total: appUsersTotal.value,
}));

// — User-history modal state
const historyModalOpen = ref(false);
const historyModalUserId = ref<string | null>(null);
const historyModalUserName = ref<string>('');
const historyRefreshKey = ref(0);
function openHistory(ua: UserApplication) {
  historyModalUserId.value = ua.userId;
  historyModalUserName.value = getUserName(ua.userId);
  historyModalOpen.value = true;
}

// — Activity strip (online + sparkline + 7d logins)
const appActivity = ref<AppActivityEntry | null>(null);
async function loadAppActivity() {
  try {
    const [activityRes, loginsRes] = await Promise.all([
      getApplicationsActivity(),
      getLogins({ range: '7d', appId }),
    ]);
    const entry = activityRes.applications.find(a => a.appId === appId);
    if (entry) {
      appActivity.value = entry;
    } else {
      // Fallback: synthesise a sparkline from the per-app logins endpoint.
      appActivity.value = {
        appId,
        online: 0,
        last7dLogins: loginsRes.total,
        sparkline: loginsRes.series.map(p => p.count),
      };
    }
  } catch {
    // Silent — activity strip is non-critical.
  }
}

const userColumns = computed<ColumnDef<UserApplication>[]>(() => [
  { key: 'user', label: t('users.columns.name') },
  { key: 'role', label: t('users.columns.role'), responsive: 'sm' },
  { key: 'plan', label: 'Plan', responsive: 'sm' },
  { key: 'status', label: 'Status', responsive: 'md' },
  { key: 'lastLogin', label: t('users.columns.lastLogin'), field: 'lastLoginAt', sortable: true, responsive: 'md' },
  { key: 'ipAddress', label: t('users.columns.ipAddress'), field: 'lastIp', responsive: 'lg' },
  { key: 'ua', label: t('users.columns.device'), responsive: 'lg' },
  { key: 'history', label: t('users.columns.history'), align: 'right' },
  { key: 'actions', label: t('users.columns.actions'), align: 'right' },
]);

// Format with date + time (per spec) so admins can see at a glance the
// exact moment of the last successful login on this application.
function formatLastLogin(iso: string | null | undefined): string {
  if (!iso) return t('users.never');
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function openGrantModal() {
  userForm.value = { userId: '', roleId: '', subscriptionPlanId: '' };
  showUserModal.value = true;
}

function openBulkModal() {
  bulkForm.value = { organizationId: '', roleId: '', subscriptionPlanId: '' };
  showBulkUserModal.value = true;
}

function openManagePlanModal(ua: UserApplication) {
  managePlanForm.value = {
    userId: ua.userId,
    planId: ua.subscriptionPlanId ?? '',
    reason: '',
  };
  showManageUserPlanModal.value = true;
}

async function handleManagePlan() {
  if (!managePlanForm.value.userId || managePlanForm.value.reason.trim() === '') return;
  managePlanLoading.value = true;
  try {
    await appsApi.updateAppAccess(appId, managePlanForm.value.userId, {
      subscriptionPlanId: managePlanForm.value.planId || null,
      reason: managePlanForm.value.reason.trim(),
    });
    await reloadUsers();
    refreshAnalytics();
    toast.success(t('appDetail.planChanged'));
    showManageUserPlanModal.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    managePlanLoading.value = false;
  }
}

// Selecting a user who already has access pre-fills their current role/plan so
// the same dialog can be used to change the role instead of silently ignoring it.
watch(
  () => userForm.value.userId,
  (userId) => {
    const existing = appUsers.value.find((u) => u.userId === userId);
    if (!existing) return;
    userForm.value.roleId = existing.roleId ?? '';
    userForm.value.subscriptionPlanId = existing.subscriptionPlanId ?? '';
  },
);

async function handleGrantAccess() {
  if (!userForm.value.userId) return;
  formLoading.value = true;
  try {
    await appsApi.grantAppAccess(appId, {
      userId: userForm.value.userId,
      roleId: userForm.value.roleId || undefined,
      subscriptionPlanId: userForm.value.subscriptionPlanId || undefined,
    });
    await reloadUsers();
    refreshAnalytics();
    toast.success('Access granted');
    showUserModal.value = false;
    userForm.value = { userId: '', roleId: '', subscriptionPlanId: '' };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
  }
}

async function handleBulkGrantAccess() {
  if (!bulkForm.value.organizationId) return;
  formLoading.value = true;
  try {
    const res = await appsApi.bulkGrantAppAccess(appId, {
      organizationId: bulkForm.value.organizationId,
      roleId: bulkForm.value.roleId || undefined,
      subscriptionPlanId: bulkForm.value.subscriptionPlanId || undefined,
    });
    await reloadUsers();
    refreshAnalytics();
    toast.success(t('appDetail.bulkGrantSuccess', { count: res.granted }));
    if ((res.skipped ?? 0) > 0) {
      toast.info(t('appDetail.bulkGrantSkipped', { count: res.skipped }));
    }
    showBulkUserModal.value = false;
    bulkForm.value = { organizationId: '', roleId: '', subscriptionPlanId: '' };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
  }
}

async function handleRevokeAccess() {
  if (!selectedUserId.value) return;
  formLoading.value = true;
  try {
    await appsApi.revokeAppAccess(appId, selectedUserId.value);
    await reloadUsers();
    refreshAnalytics();
    toast.success('Access revoked');
    showDeleteUserConfirm.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
  }
}

function openPlanEditor(plan: SubscriptionPlan | null): void {
  planEditor.value = { open: true, plan };
}

async function reloadPlans(): Promise<void> {
  plans.value = (await appsApi.listPlans(appId)).plans;
  if (pricesPlan.value) {
    const current = pricesPlan.value.id;
    pricesPlan.value = plans.value.find((p) => p.id === current) ?? null;
  }
}

async function handleResetMetric() {
  if (!selectedMetric.value) return;
  formLoading.value = true;
  try {
    await consumptionApi.resetConsumption(selectedMetric.value.userId, appId, selectedMetric.value.key);
    await loadConsumption();
    toast.success('Metric reset');
    showResetMetricConfirm.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
  }
}

async function handleRotate() {
  formLoading.value = true;
  try {
    const res = await rotateSecret(appId);
    newSecret.value = res.clientSecret;
    showRotateConfirm.value = false;
    showSecretModal.value = true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
  }
}

function getUserName(userId: string) {
  // Prefer the denormalised name already in the userApplication row (avoids extra lookup)
  const ua = appUsers.value.find(u => u.userId === userId);
  if (ua?.name) return ua.name;
  if (ua && ua.name === null) return t('appDetail.deletedUser');
  return t('appDetail.deletedUser');
}
function getUserEmail(userId: string) {
  const ua = appUsers.value.find(u => u.userId === userId);
  if (ua?.email) return ua.email;
  if (ua && ua.email === null) return '';
  return '';
}
function getUserImage(userId: string) {
  return appUsers.value.find(u => u.userId === userId)?.image ?? null;
}
function isDeletedUser(userId: string) {
  const ua = appUsers.value.find(u => u.userId === userId);
  return ua ? ua.name === null : false;
}
function getRoleName(roleId: string | null) { return roleId ? roles.value.find(r => r.id === roleId)?.name ?? roleId : t('common.none'); }
function getPlanName(planId: string | null) { return planId ? plans.value.find(p => p.id === planId)?.name ?? planId : t('common.none'); }

function formatPrice(amount: string, currency: string) {
    return formatMinorAmount(Number(amount), currency, { locale: 'en', minimumFractionDigits: 0 });
}


async function loadUserOptions(search: string): Promise<SelectOption[]> {
  const res = await listUsers({ search: search || undefined, limit: 10 });
  return res.users.map(u => ({
    value: u.id,
    label: u.name ?? u.email,
    description: u.email,
    avatar: { name: u.name ?? u.email, image: u.image },
  }));
}

async function loadOrganizationOptions(search: string): Promise<SelectOption[]> {
  const res = await listOrganizations({ search: search || undefined, limit: 10 });
  return res.organizations.map(o => ({ value: o.id, label: o.name, description: o.slug, icon: Building2 }));
}

function loadRoleOptions(search: string): Promise<SelectOption[]> {
  const lower = search.toLowerCase();
  const filtered = roles.value.filter(r => !search || r.name.toLowerCase().includes(lower));
  const items = filtered.map(r => ({ value: r.id, label: r.name, description: r.description ?? undefined, icon: Shield }));
  return Promise.resolve([{ value: '', label: t('common.none'), icon: Ban }, ...items]);
}
async function openInviteFromUsers() {
  activeTab.value = 'invitations';
  await nextTick();
  invitationsTabRef.value?.openModal();
}

const tabs = computed<Array<{ key: AppTabKey; label: string }>>(() => {
  const base: Array<{ key: AppTabKey; label: string }> = [
    { key: 'roles', label: t('appDetail.rolesPermissions') },
    { key: 'users', label: t('appDetail.users') },
  ];
  if (resourceSharing.value && app.value?.resourceSharingEnabled) {
    base.push({ key: 'sharing', label: t('appDetail.sharing') });
  }
  base.push(
    { key: 'plans', label: t('appDetail.plans') },
    { key: 'invitations', label: t('appDetail.invitations') },
    { key: 'integration', label: t('appDetail.integration') },
    { key: 'consumption', label: t('appDetail.consumption') },
    { key: 'financial', label: t('appDetail.financial') },
  );
  return base;
});

const tabOptions = computed<SelectOption[]>(() =>
  tabs.value.map((tab) => ({ value: tab.key, label: tab.label })),
);

function setActiveTab(value: string) {
  activeTab.value = value as AppTabKey;
}

</script>

<template>
  <AppLayout :title="app?.name ?? 'Application'" :subtitle="app?.slug">
    <div class="space-y-5 max-w-[1600px] mx-auto">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <BaseButton variant="ghost" size="sm" @click="router.go(-1)">
          <ArrowLeft class="w-4 h-4" />
          {{ t('common.back') }}
        </BaseButton>
        <div v-if="app" class="flex items-center gap-2 flex-wrap">
          <BaseBadge :variant="app.isActive ? 'success' : 'neutral'" dot>{{ app.isActive ? t('common.active') : t('common.inactive') }}</BaseBadge>
          <BaseBadge variant="neutral">{{ app.isPublic ? t('applications.public') : t('applications.confidential') }}</BaseBadge>
        </div>
      </div>

      <div v-if="appActivity" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5 sm:px-5">
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <div class="flex items-center gap-2">
            <Activity
              class="w-4 h-4"
              :class="appActivity.online > 0 ? 'text-emerald-400' : 'text-surface-600'"
            />
            <span class="text-surface-200 font-semibold">{{ appActivity.online }}</span>
            <span class="text-xs text-surface-500">{{ t('applications.activity.online') }}</span>
          </div>
          <div class="h-5 w-px bg-surface-700/60" />
          <div class="flex items-center gap-2">
            <TrendingUp class="w-4 h-4 text-primary-400" />
            <span class="text-surface-200 font-semibold">{{ appActivity.last7dLogins }}</span>
            <span class="text-xs text-surface-500">{{ t('applications.activity.last7d') }}</span>
          </div>
        </div>
        <Sparkline :values="appActivity.sparkline" :width="140" :height="32" class="self-start sm:self-auto" />
      </div>

      <div class="sm:hidden">
        <BaseSelect
          :model-value="activeTab"
          :options="tabOptions"
          @update:model-value="setActiveTab"
        />
      </div>
      <div class="hidden sm:flex gap-1 p-1 bg-surface-900/60 rounded-xl border border-surface-700/40 overflow-x-auto scroll-smooth">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          @click="activeTab = tab.key"
          :class="['px-3 py-1.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap', activeTab === tab.key ? 'bg-primary-600/20 text-primary-300 shadow-sm' : 'text-surface-500 hover:text-surface-300']"
        >
          {{ tab.label }}
        </button>
      </div>

      <div v-if="loading" class="space-y-3">
        <div v-for="i in 4" :key="i" class="h-16 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-xl" />
      </div>

      <template v-else>
        <RolesPermissionsTab
          v-if="activeTab === 'roles'"
          v-model:roles="roles"
          v-model:permissions="permissions"
          :app-id="appId"
          :app-name="app?.name ?? ''"
        />

        <AppSharingSettings v-if="activeTab === 'sharing'" :app-id="appId" />

        <div v-if="activeTab === 'users'" class="space-y-4">
          <div class="grid grid-cols-1 gap-2 sm:flex sm:justify-end">
            <BaseButton class="w-full sm:w-auto" size="sm" @click="openInviteFromUsers"><Mail class="w-3.5 h-3.5" />{{ t('appDetail.inviteUser') }}</BaseButton>
            <BaseButton class="w-full sm:w-auto" size="sm" variant="outline" @click="openGrantModal"><Plus class="w-3.5 h-3.5" />{{ t('appDetail.grantAccess') }}</BaseButton>
            <BaseButton class="w-full sm:w-auto" size="sm" variant="outline" @click="openBulkModal"><Users class="w-3.5 h-3.5" />{{ t('appDetail.bulkGrantAccess') }}</BaseButton>
          </div>
          <DataTable
            :columns="userColumns"
            :items="appUsers"
            :loading="loading"
            :empty="!loading && appUsers.length === 0"
            :row-key="(u: UserApplication) => u.userId"
            searchable
            :search="appUsersSearch"
            :pagination="appUsersPagination"
            @update:search="appUsersSearch = $event"
            @update:page="onAppUsersPageChange"
            @update:limit="onAppUsersLimitChange"
          >
            <template #empty>
              <div class="px-5 py-8 text-center text-sm text-surface-500">No users with access</div>
            </template>
            <template #cell-user="{ row }">
              <div class="flex items-center gap-3" :class="{ 'opacity-60': isDeletedUser((row as UserApplication).userId) }">
                <UserAvatar :name="getUserName((row as UserApplication).userId)" :image="getUserImage((row as UserApplication).userId)" size="sm" />
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <p class="text-sm font-medium text-surface-200 truncate">{{ getUserName((row as UserApplication).userId) }}</p>
                    <BaseBadge v-if="isDeletedUser((row as UserApplication).userId)" variant="error" size="sm">{{ t('appDetail.deletedUser') }}</BaseBadge>
                  </div>
                  <p class="text-xs text-surface-500 truncate">{{ getUserEmail((row as UserApplication).userId) }}</p>
                </div>
              </div>
            </template>
            <template #cell-role="{ row }">
              <BaseBadge variant="neutral" size="sm">{{ getRoleName((row as UserApplication).roleId) }}</BaseBadge>
            </template>
            <template #cell-plan="{ row }">
              <BaseBadge variant="neutral" size="sm">{{ getPlanName((row as UserApplication).subscriptionPlanId) }}</BaseBadge>
            </template>
            <template #cell-status="{ row }">
              <BaseBadge :variant="(row as UserApplication).isActive ? 'success' : 'neutral'" size="sm" dot>
                {{ (row as UserApplication).isActive ? t('common.active') : t('common.inactive') }}
              </BaseBadge>
            </template>
            <template #cell-lastLogin="{ row }">
              <span class="text-xs text-surface-500">{{ formatLastLogin((row as UserApplication).lastLoginAt) }}</span>
            </template>
            <template #cell-ipAddress="{ row }">
              <span class="text-xs text-surface-400">{{ (row as UserApplication).lastIp ?? '—' }}</span>
            </template>
            <template #cell-ua="{ row }">
              <span class="text-xs text-surface-400">
                <template v-if="(row as UserApplication).lastUserAgent">
                  {{ parseUserAgent((row as UserApplication).lastUserAgent!).browser }} / {{ parseUserAgent((row as UserApplication).lastUserAgent!).os }}
                </template>
                <template v-else>—</template>
              </span>
            </template>
            <template #cell-history="{ row }">
              <button
                @click="openHistory(row as UserApplication)"
                class="p-1.5 rounded-lg text-surface-500 hover:text-surface-200 hover:bg-surface-700/50 transition-colors"
                :title="t('users.history.title')"
              >
                <History class="w-4 h-4" />
              </button>
            </template>
            <template #cell-actions="{ row }">
              <div class="flex items-center justify-end gap-1">
                <button
                  @click="openManagePlanModal(row as UserApplication)"
                  class="p-1.5 rounded-lg text-surface-500 hover:text-primary-300 hover:bg-primary-500/10 transition-all"
                  :title="t('appDetail.manageSubscription')"
                >
                  <CreditCard class="w-4 h-4" />
                </button>
                <button
                  @click="selectedUserId = (row as UserApplication).userId; showDeleteUserConfirm = true"
                  class="p-1.5 rounded-lg text-red-500 hover:bg-red-500/10 transition-all"
                >
                  <Trash2 class="w-4 h-4" />
                </button>
              </div>
            </template>
          </DataTable>
        </div>

        <ApplicationInvitationsTab v-if="activeTab === 'invitations'" ref="invitationsTabRef" :application-id="appId" />

        <div v-if="activeTab === 'plans'" class="space-y-4">
          <div class="flex justify-end">
            <BaseButton size="sm" @click="openPlanEditor(null)"><Plus class="w-3.5 h-3.5" />{{ t('appDetail.createPlan') }}</BaseButton>
          </div>
          <div v-if="!plans.length" class="text-center text-sm text-surface-500 py-8">No plans yet</div>
          <div v-else class="space-y-4">
            <div v-for="plan in plans" :key="plan.id" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
              <div class="flex items-start justify-between mb-3">
                <div>
                  <div class="flex items-center gap-2">
                    <p class="text-sm font-semibold text-surface-200 capitalize">{{ plan.name }}</p>
                    <BaseBadge v-if="plan.isDefault" variant="primary" size="sm">default</BaseBadge>
                    <BaseBadge v-if="plan.stripeProductId" variant="success" size="sm">Stripe</BaseBadge>
                  </div>
                  <p class="text-xs text-surface-500 mt-1">{{ plan.description }}</p>
                </div>
                <div class="flex items-center gap-3">
                  <button @click="openPlanEditor(plan)" class="text-xs text-surface-400 hover:text-surface-200 transition-colors">{{ t('common.edit') }}</button>
                  <button @click="pricesPlan = plan" class="text-xs text-primary-400 hover:text-primary-300 transition-colors">{{ t('plans.prices.manage') }}</button>
                </div>
              </div>

              <div v-if="Object.keys(plan.features).length" class="mb-3 flex flex-wrap gap-2">
                <div v-for="(value, key) in plan.features" :key="key" class="px-2.5 py-1 rounded-lg bg-surface-800/60 border border-surface-700/30 text-xs flex items-center gap-1.5">
                  <span class="text-surface-500 font-mono">{{ key }}</span>
                  <BaseBadge v-if="typeof value === 'boolean'" :variant="value ? 'success' : 'neutral'" size="sm">{{ value ? t('common.enabled') : t('common.disabled') }}</BaseBadge>
                  <span v-else class="text-surface-100 font-semibold">{{ String(value) }}</span>
                </div>
              </div>

              <div v-if="plan.prices.length" class="space-y-2 pt-3 border-t border-surface-800/40">
                <div v-for="price in plan.prices" :key="price.id" class="flex items-center justify-between gap-3 text-sm">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="text-surface-300 truncate">{{ price.name }}</span>
                    <BaseBadge v-if="price.billingType === 'metered'" variant="warning" size="sm">{{ t('appDetail.metered') }}</BaseBadge>
                  </div>
                  <div class="flex items-center gap-3 shrink-0">
                    <span v-if="price.billingType === 'metered'" class="font-semibold text-surface-100">{{ formatPrice(price.amount, price.currency) }} / {{ price.unit }}</span>
                    <span v-else class="font-semibold text-surface-100">{{ formatPrice(price.amount, price.currency) }} / {{ price.interval }}</span>
                    <BaseBadge v-if="price.stripePriceId" variant="success" size="sm">Stripe</BaseBadge>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <ApplicationIntegrationTab
          v-if="activeTab === 'integration' && app"
          :app="app"
          :services-config="services.config"
          :auth-service-url="authServiceUrl"
          @rotate="showRotateConfirm = true"
        />

        <ApplicationConsumptionTab
          v-if="activeTab === 'consumption'"
          :consumption="consumption"
          :plans="plans"
          :app-users="appUsers"
          @reset="selectedMetric = $event; showResetMetricConfirm = true"
        />

        <ApplicationFinancialTab
          v-if="activeTab === 'financial'"
          :subscriptions="appSubscriptions"
          :plans="plans"
          :consumption="consumption"
        />
      </template>
    </div>

    <BaseModal :open="showBulkUserModal" :title="t('appDetail.bulkGrantAccess')" @close="showBulkUserModal = false">
      <div class="space-y-4">
        <p class="text-sm text-surface-400">{{ t('appDetail.bulkGrantHint') }}</p>
        <SearchSelect
          v-model="bulkForm.organizationId"
          :label="t('appDetail.organization')"
          :load-options="loadOrganizationOptions"
          :placeholder="t('appDetail.searchOrganizations')"
          required
        />
        <SearchSelect
          v-model="bulkForm.roleId"
          :label="t('appDetail.role')"
          :load-options="loadRoleOptions"
          :placeholder="t('appDetail.searchRoles')"
        />
        <BaseSelect
          v-model="bulkForm.subscriptionPlanId"
          :label="t('appDetail.subscriptionPlan')"
          :options="defaultPlanSelectOptions"
        />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showBulkUserModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" :disabled="!bulkForm.organizationId" @click="handleBulkGrantAccess">{{ t('appDetail.grantAccess') }}</BaseButton>
      </template>
    </BaseModal>

    <BaseModal :open="showUserModal" :title="t('appDetail.grantAccess')" @close="showUserModal = false">
      <div class="space-y-4">
        <SearchSelect v-model="userForm.userId" :label="t('common.user')" :load-options="loadUserOptions" :placeholder="t('common.searchUsers')" required />
        <SearchSelect v-model="userForm.roleId" :label="t('appDetail.role')" :load-options="loadRoleOptions" :placeholder="t('appDetail.searchRoles')" />
        <BaseSelect v-model="userForm.subscriptionPlanId" :label="t('appDetail.subscriptionPlan')" :options="planOptions" />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showUserModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleGrantAccess">{{ t('appDetail.grantAccess') }}</BaseButton>
      </template>
    </BaseModal>

    <BaseModal :open="showManageUserPlanModal" :title="t('appDetail.manageSubscription')" @close="showManageUserPlanModal = false">
      <div class="space-y-4">
        <p class="text-sm text-surface-400">{{ t('appDetail.manageSubscriptionHint') }}</p>
        <BaseSelect
          v-model="managePlanForm.planId"
          :label="t('appDetail.subscriptionPlan')"
          :options="noPlanSelectOptions"
        />
        <BaseInput v-model="managePlanForm.reason" :label="t('appDetail.changeReason')" :hint="t('wallet.admin.form.reasonHint')" required />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showManageUserPlanModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="managePlanLoading" :disabled="managePlanForm.reason.trim() === ''" @click="handleManagePlan">{{ t('common.save') }}</BaseButton>
      </template>
    </BaseModal>

    <PlanEditorModal
      :open="planEditor.open"
      :app-id="appId"
      :plan="planEditor.plan"
      @close="planEditor.open = false"
      @saved="reloadPlans"
    />

    <PlanPricesDialog
      v-if="pricesPlan"
      :open="true"
      :app-id="appId"
      :plan="pricesPlan"
      @close="pricesPlan = null"
      @changed="reloadPlans"
    />

    <BaseModal :open="showSecretModal" title="New Client Secret" @close="showSecretModal = false">
      <div class="space-y-3">
        <div class="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
          <AlertTriangle class="w-4 h-4 text-amber-400 mt-0.5" />
          <p class="text-sm text-amber-300">{{ t('applications.secretCreated') }}</p>
        </div>
        <CopyField :value="newSecret" label="Client Secret" />
      </div>
      <template #footer>
        <BaseButton @click="showSecretModal = false">{{ t('common.close') }}</BaseButton>
      </template>
    </BaseModal>

    <ConfirmDialog :open="showDeleteUserConfirm" :title="t('appDetail.revokeAccess')" message="Revoke this user's access to the application?" :loading="formLoading" @confirm="handleRevokeAccess" @cancel="showDeleteUserConfirm = false" />
    <ConfirmDialog :open="showResetMetricConfirm" :title="t('appDetail.resetMetric')" :message="t('appDetail.confirmResetMetric')" :loading="formLoading" @confirm="handleResetMetric" @cancel="showResetMetricConfirm = false" />
    <ConfirmDialog :open="showRotateConfirm" :title="t('applications.rotateSecret')" :message="t('applications.rotateSecretConfirm')" :loading="formLoading" @confirm="handleRotate" @cancel="showRotateConfirm = false" />
    <ConfirmDialog :open="showDeletePlanConfirm" :title="t('appDetail.deletePlan')" message="Delete this plan?" :loading="formLoading" @confirm="async () => { if (selectedPlanId) { await appsApi.deletePlan(appId, selectedPlanId); plans = (await appsApi.listPlans(appId)).plans; showDeletePlanConfirm = false; } }" @cancel="showDeletePlanConfirm = false" />

    <UserAppHistoryModal
      v-if="historyModalUserId"
      :open="historyModalOpen"
      :app-id="appId"
      :user-id="historyModalUserId"
      :user-name="historyModalUserName"
      :refresh-key="historyRefreshKey"
      @close="historyModalOpen = false"
    />
  </AppLayout>
</template>
