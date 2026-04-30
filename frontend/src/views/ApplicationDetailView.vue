<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useServicesStore } from '@/stores/services';
import * as appsApi from '@/api/applications';
import * as consumptionApi from '@/api/consumption';
import { listUsers } from '@/api/users';
import { useToast } from '@/composables/useToast';
import { rotateSecret } from '@/api/applications';
import type { Application, AppRole, AppPermission, SubscriptionPlan, UserApplication, ConsumptionAggregate, User } from '@/types';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import CopyField from '@/components/ui/CopyField.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import type { PlanFeature } from '@/types';
import { ArrowLeft, Plus, Trash2, RefreshCw, Check, X, AlertTriangle, Code, TrendingUp } from 'lucide-vue-next';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const toast = useToast();
const services = useServicesStore();

const appId = route.params.id as string;
const activeTab = ref<'roles' | 'users' | 'plans' | 'integration' | 'consumption' | 'financial'>('roles');

const app = ref<Application | null>(null);
const roles = ref<AppRole[]>([]);
const permissions = ref<AppPermission[]>([]);
const appUsers = ref<UserApplication[]>([]);
const plans = ref<SubscriptionPlan[]>([]);
const consumption = ref<ConsumptionAggregate[]>([]);
const allUsers = ref<User[]>([]);
const loading = ref(true);

const showRoleModal = ref(false);
const showPermModal = ref(false);
const showUserModal = ref(false);
const showPlanModal = ref(false);
const showPriceModal = ref(false);
const showDeleteRoleConfirm = ref(false);
const showDeletePermConfirm = ref(false);
const showDeletePlanConfirm = ref(false);
const showRotateConfirm = ref(false);
const showSecretModal = ref(false);
const showDeleteUserConfirm = ref(false);
const showResetMetricConfirm = ref(false);

const formLoading = ref(false);
const newSecret = ref('');
const selectedRoleId = ref<string | null>(null);
const selectedPermId = ref<string | null>(null);
const selectedPlanId = ref<string | null>(null);
const selectedUserId = ref<string | null>(null);
const selectedMetric = ref<{ userId: string; key: string } | null>(null);

const roleForm = ref({ name: '', description: '', isDefault: false });
const permForm = ref({ resource: '', action: 'read' as 'read' | 'write' });
const userForm = ref({ userId: '', roleId: '' });
const planForm = ref({ name: '', description: '', isDefault: false });
const priceForm = ref({ name: '', amount: '', currency: 'eur', interval: 'month' as 'month' | 'year' | 'one_time', planId: '' });
const editingPlanId = ref<string | null>(null);
const planFeatureEntries = ref<Array<{ key: string; usage: boolean; value: string; limit: string; unit: string; pricePerUnit: string }>>([]);;

onMounted(async () => {
  await services.fetch();
  await loadAll();
});

async function loadAll() {
  loading.value = true;
  try {
    const [appRes, rolesRes, permsRes, usersRes, plansRes, allUsersRes] = await Promise.all([
      appsApi.getApplication(appId),
      appsApi.listRoles(appId),
      appsApi.listPermissions(appId),
      appsApi.listAppUsers(appId),
      appsApi.listPlans(appId),
      listUsers({ limit: 200 }),
    ]);
    app.value = appRes.application;
    roles.value = rolesRes.roles;
    permissions.value = permsRes.permissions;
    appUsers.value = usersRes.users;
    plans.value = plansRes.plans;
    allUsers.value = allUsersRes.users;
    await loadConsumption();
  } finally {
    loading.value = false;
  }
}

async function loadConsumption() {
  const allAggs: ConsumptionAggregate[] = [];
  for (const ua of appUsers.value) {
    const res = await consumptionApi.getUserConsumption(ua.userId, appId);
    allAggs.push(...res.aggregates);
  }
  consumption.value = allAggs;
}

async function handleCreateRole() {
  formLoading.value = true;
  try {
    await appsApi.createRole(appId, roleForm.value);
    roles.value = (await appsApi.listRoles(appId)).roles;
    toast.success('Role created');
    showRoleModal.value = false;
    roleForm.value = { name: '', description: '', isDefault: false };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
  }
}

async function handleDeleteRole() {
  if (!selectedRoleId.value) return;
  formLoading.value = true;
  try {
    await appsApi.deleteRole(appId, selectedRoleId.value);
    roles.value = roles.value.filter(r => r.id !== selectedRoleId.value);
    toast.success('Role deleted');
    showDeleteRoleConfirm.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
  }
}

async function handleCreatePerm() {
  formLoading.value = true;
  try {
    await appsApi.createPermission(appId, permForm.value);
    permissions.value = (await appsApi.listPermissions(appId)).permissions;
    toast.success('Permission created');
    showPermModal.value = false;
    permForm.value = { resource: '', action: 'read' };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
  }
}

async function togglePermission(roleId: string, permId: string, currentlyAssigned: boolean) {
  try {
    if (currentlyAssigned) {
      await appsApi.removePermissionFromRole(appId, roleId, permId);
      const role = roles.value.find(r => r.id === roleId);
      if (role) role.permissionIds = role.permissionIds.filter(p => p !== permId);
    } else {
      await appsApi.assignPermissionToRole(appId, roleId, permId);
      const role = roles.value.find(r => r.id === roleId);
      if (role) role.permissionIds.push(permId);
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  }
}

async function handleGrantAccess() {
  if (!userForm.value.userId) return;
  formLoading.value = true;
  try {
    await appsApi.grantAppAccess(appId, { userId: userForm.value.userId, roleId: userForm.value.roleId || undefined });
    appUsers.value = (await appsApi.listAppUsers(appId)).users;
    toast.success('Access granted');
    showUserModal.value = false;
    userForm.value = { userId: '', roleId: '' };
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
    appUsers.value = appUsers.value.filter(u => u.userId !== selectedUserId.value);
    toast.success('Access revoked');
    showDeleteUserConfirm.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
  }
}

function parseFeature(v: unknown): PlanFeature {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (obj.usage === true) {
      return {
        usage: true,
        limit: typeof obj.limit === 'number' ? obj.limit : -1,
        unit: typeof obj.unit === 'string' ? obj.unit : '',
        pricePerUnit: typeof obj.pricePerUnit === 'number' ? obj.pricePerUnit : 0,
      };
    }
    // Legacy { value: X } format (from old JSON textarea)
    if ('value' in obj) {
      const raw = obj.value;
      if (typeof raw === 'boolean') return { usage: false, value: raw };
      if (typeof raw === 'number') return { usage: false, value: raw };
      return { usage: false, value: String(raw ?? '') };
    }
  }
  if (typeof v === 'boolean') return { usage: false, value: v };
  if (typeof v === 'number') return { usage: false, value: v };
  return { usage: false, value: String(v ?? '') };
}

function isPlanFeatureMetered(v: unknown): v is { usage: true; limit: number; unit: string; pricePerUnit: number } {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>).usage === true;
}

function planFeatureParsed(features: Record<string, unknown>): Array<{ key: string; feature: PlanFeature }> {
  return Object.entries(features).map(([k, v]) => ({ key: k, feature: parseFeature(v) }));
}

function coerceFeatureValue(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  if (!isNaN(n) && v.trim() !== '') return n;
  return v;
}

function openEditPlan(plan: SubscriptionPlan) {
  editingPlanId.value = plan.id;
  planForm.value = { name: plan.name, description: plan.description ?? '', isDefault: plan.isDefault };
  planFeatureEntries.value = Object.entries(plan.features).map(([k, v]) => {
    const parsed = parseFeature(v);
    if (parsed.usage) {
      return { key: k, usage: true, value: '', limit: String(parsed.limit), unit: parsed.unit, pricePerUnit: String(parsed.pricePerUnit) };
    }
    return { key: k, usage: false, value: String(parsed.value), limit: '-1', unit: '', pricePerUnit: '0' };
  });
  showPlanModal.value = true;
}

function closePlanModal() {
  showPlanModal.value = false;
  editingPlanId.value = null;
  planFeatureEntries.value = [];
  planForm.value = { name: '', description: '', isDefault: false };
}

async function handleSavePlan() {
  formLoading.value = true;
  try {
    const features = Object.fromEntries(
      planFeatureEntries.value
        .filter(e => e.key.trim())
        .map(e => {
          if (e.usage) {
            return [e.key.trim(), { usage: true, limit: Number(e.limit) || -1, unit: e.unit, pricePerUnit: Number(e.pricePerUnit) || 0 } as PlanFeature];
          }
          return [e.key.trim(), coerceFeatureValue(e.value)];
        })
    );
    if (editingPlanId.value) {
      await appsApi.updatePlan(appId, editingPlanId.value, { name: planForm.value.name, description: planForm.value.description, isDefault: planForm.value.isDefault, features });
      toast.success('Plan updated');
    } else {
      await appsApi.createPlan(appId, { name: planForm.value.name, description: planForm.value.description, isDefault: planForm.value.isDefault, features });
      toast.success('Plan created');
    }
    plans.value = (await appsApi.listPlans(appId)).plans;
    closePlanModal();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
  }
}

async function handleAddPrice() {
  if (!priceForm.value.planId || priceForm.value.amount === '') return;
  formLoading.value = true;
  try {
    await appsApi.createPrice(appId, priceForm.value.planId, { name: priceForm.value.name, amount: Number(priceForm.value.amount), currency: priceForm.value.currency, interval: priceForm.value.interval });
    plans.value = (await appsApi.listPlans(appId)).plans;
    toast.success('Price added');
    showPriceModal.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
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
  return allUsers.value.find(u => u.id === userId)?.name ?? t('appDetail.deletedUser');
}
function getUserEmail(userId: string) {
  const ua = appUsers.value.find(u => u.userId === userId);
  if (ua?.email) return ua.email;
  if (ua && ua.email === null) return '';
  return allUsers.value.find(u => u.id === userId)?.email ?? '';
}
function getUserImage(userId: string) {
  return allUsers.value.find(u => u.id === userId)?.image ?? null;
}
function isDeletedUser(userId: string) {
  const ua = appUsers.value.find(u => u.userId === userId);
  return ua ? ua.name === null : false;
}
function getRoleName(roleId: string | null) { return roleId ? roles.value.find(r => r.id === roleId)?.name ?? roleId : t('common.none'); }
function getPlanName(planId: string | null) { return planId ? plans.value.find(p => p.id === planId)?.name ?? planId : t('common.none'); }

function formatPrice(amount: string, currency: string) {
  return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 0 }).format(Number(amount) / 100);
}

function formatDate(iso: string) { return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }); }

const userOptions = computed(() => allUsers.value.map(u => ({ value: u.id, label: `${u.name} (${u.email})` })));
const roleOptions = computed(() => roles.value.map(r => ({ value: r.id, label: r.name })));
const intervalOptions = [
  { value: 'month', label: t('appDetail.month') },
  { value: 'year', label: t('appDetail.year') },
  { value: 'one_time', label: t('appDetail.one_time') },
];

const tabs = [
  { key: 'roles', label: t('appDetail.rolesPermissions') },
  { key: 'users', label: t('appDetail.users') },
  { key: 'plans', label: t('appDetail.plans') },
  { key: 'integration', label: t('appDetail.integration') },
  { key: 'consumption', label: t('appDetail.consumption') },
  { key: 'financial', label: t('appDetail.financial') },
] as const;

const codeExampleJS = computed(() => {
  if (!app.value) return '';
  const redirectUri = app.value.redirectUris[0] ?? 'https://your-app.com/callback';
  return `const params = new URLSearchParams({
  response_type: 'code',
  client_id: '${app.value.slug}',
  redirect_uri: '${redirectUri}',
  scope: '${app.value.allowedScopes.join(' ')}',
  code_challenge_method: 'S256',
  code_challenge: await generateCodeChallenge(codeVerifier),
});
window.location.href = \`/api/auth/authorize?\${params}\`;`;
});

const PROVIDERS = ['google', 'github', 'linkedin', 'microsoft', 'apple'] as const;
type PKey = typeof PROVIDERS[number];

const financialKpis = computed(() => {
  const subscribedUsers = appUsers.value.filter(u => u.subscriptionPlanId);
  const activeSubscribers = subscribedUsers.filter(u => u.isActive).length;

  let mrr = 0;
  const planRevenue: Record<string, { name: string; subscribers: number; monthly: number; currency: string }> = {};

  for (const ua of subscribedUsers) {
    if (!ua.subscriptionPlanId) continue;
    const plan = plans.value.find(p => p.id === ua.subscriptionPlanId);
    if (!plan) continue;
    const price = plan.prices.find(p => p.interval === 'month');
    const amount = price ? Number(price.amount) : 0;
    const currency = price?.currency ?? 'eur';
    mrr += amount;

    if (!planRevenue[plan.id]) planRevenue[plan.id] = { name: plan.name, subscribers: 0, monthly: 0, currency };
    planRevenue[plan.id].subscribers += 1;
    planRevenue[plan.id].monthly += amount;
  }

  // Aggregate metered usage per feature key
  const meteredKeys = new Map<string, { unit: string; totalUsage: number; pricePerUnit: number; revenue: number; currency: string }>();
  for (const plan of plans.value) {
    const currency = plan.prices.find(p => p.interval === 'month')?.currency ?? 'eur';
    for (const [key, v] of Object.entries(plan.features)) {
      if (!isPlanFeatureMetered(v)) continue;
      const feature = v as { usage: true; limit: number; unit: string; pricePerUnit: number };
      if (!meteredKeys.has(key)) meteredKeys.set(key, { unit: feature.unit, totalUsage: 0, pricePerUnit: feature.pricePerUnit, revenue: 0, currency });
      // Sum consumption for users on this plan
      for (const ua of subscribedUsers.filter(u => u.subscriptionPlanId === plan.id)) {
        const agg = consumption.value.find(c => c.userId === ua.userId && c.key === key);
        if (!agg) continue;
        const total = Number(agg.total);
        const entry = meteredKeys.get(key)!;
        entry.totalUsage += total;
        entry.revenue += total * feature.pricePerUnit;
      }
    }
  }

  return {
    activeSubscribers,
    mrr,
    arr: mrr * 12,
    currency: Object.values(planRevenue)[0]?.currency ?? 'eur',
    byPlan: Object.values(planRevenue),
    meteredUsage: [...meteredKeys.entries()].map(([key, v]) => ({ key, ...v })),
  };
});
</script>

<template>
  <AppLayout :title="app?.name ?? 'Application'" :subtitle="app?.slug">
    <div class="space-y-5">
      <div class="flex items-center justify-between">
        <BaseButton variant="ghost" size="sm" @click="router.back()">
          <ArrowLeft class="w-4 h-4" />
          {{ t('common.back') }}
        </BaseButton>
        <div v-if="app" class="flex items-center gap-2">
          <BaseBadge :variant="app.isActive ? 'success' : 'neutral'" dot>{{ app.isActive ? t('common.active') : t('common.inactive') }}</BaseBadge>
          <BaseBadge variant="neutral">{{ app.isPublic ? t('applications.public') : t('applications.confidential') }}</BaseBadge>
        </div>
      </div>

      <div class="flex gap-1 p-1 bg-surface-900/60 rounded-xl border border-surface-700/40 w-fit overflow-x-auto">
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
        <div v-if="activeTab === 'roles'" class="space-y-5">
          <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
            <div class="px-5 py-4 border-b border-surface-700/40 flex items-center justify-between">
              <h3 class="text-sm font-semibold text-surface-200">{{ t('appDetail.roles') }}</h3>
              <BaseButton size="sm" @click="showRoleModal = true"><Plus class="w-3.5 h-3.5" />{{ t('appDetail.createRole') }}</BaseButton>
            </div>
            <div v-if="!roles.length" class="px-5 py-8 text-center text-sm text-surface-500">No roles yet</div>
            <div v-else class="divide-y divide-surface-800/40">
              <div v-for="role in roles" :key="role.id" class="px-5 py-4 flex items-center gap-4 group">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <p class="text-sm font-medium text-surface-200">{{ role.name }}</p>
                    <BaseBadge v-if="role.isDefault" variant="primary" size="sm">default</BaseBadge>
                  </div>
                  <p class="text-xs text-surface-500 mt-0.5">{{ role.description ?? '—' }}</p>
                </div>
                <span class="text-xs text-surface-500">{{ role.permissionIds.length }} permissions</span>
                <button @click="selectedRoleId = role.id; showDeleteRoleConfirm = true" class="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-red-500 hover:bg-red-500/10 transition-all">
                  <Trash2 class="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
            <div class="px-5 py-4 border-b border-surface-700/40 flex items-center justify-between">
              <h3 class="text-sm font-semibold text-surface-200">{{ t('appDetail.permissions') }}</h3>
              <BaseButton size="sm" @click="showPermModal = true"><Plus class="w-3.5 h-3.5" />{{ t('appDetail.createPermission') }}</BaseButton>
            </div>
            <div v-if="!permissions.length" class="px-5 py-8 text-center text-sm text-surface-500">No permissions yet</div>
            <div v-else class="divide-y divide-surface-800/40">
              <div v-for="perm in permissions" :key="perm.id" class="px-5 py-3 flex items-center gap-4 group">
                <code class="flex-1 text-sm font-mono text-surface-300">{{ perm.resource }}:<span :class="perm.action === 'write' ? 'text-amber-400' : 'text-emerald-400'">{{ perm.action }}</span></code>
                <span class="text-xs text-surface-600">{{ formatDate(perm.createdAt) }}</span>
                <button @click="selectedPermId = perm.id; showDeletePermConfirm = true" class="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-red-500 hover:bg-red-500/10 transition-all">
                  <Trash2 class="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          <div v-if="roles.length && permissions.length" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
            <div class="px-5 py-4 border-b border-surface-700/40">
              <h3 class="text-sm font-semibold text-surface-200">{{ t('appDetail.permissionMatrix') }}</h3>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full">
                <thead>
                  <tr class="border-b border-surface-800/40">
                    <th class="px-5 py-3 text-left text-xs font-medium text-surface-500">Permission</th>
                    <th v-for="role in roles" :key="role.id" class="px-4 py-3 text-center text-xs font-medium text-surface-500">{{ role.name }}</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-surface-800/40">
                  <tr v-for="perm in permissions" :key="perm.id">
                    <td class="px-5 py-3">
                      <code class="text-xs font-mono text-surface-300">{{ perm.resource }}:{{ perm.action }}</code>
                    </td>
                    <td v-for="role in roles" :key="role.id" class="px-4 py-3 text-center">
                      <button
                        @click="togglePermission(role.id, perm.id, role.permissionIds.includes(perm.id))"
                        :class="['w-6 h-6 rounded-md flex items-center justify-center mx-auto transition-all', role.permissionIds.includes(perm.id) ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30' : 'bg-surface-800 text-surface-600 hover:bg-surface-700']"
                      >
                        <Check v-if="role.permissionIds.includes(perm.id)" class="w-3.5 h-3.5" />
                        <X v-else class="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div v-if="activeTab === 'users'" class="space-y-4">
          <div class="flex justify-end">
            <BaseButton size="sm" @click="showUserModal = true"><Plus class="w-3.5 h-3.5" />{{ t('appDetail.grantAccess') }}</BaseButton>
          </div>
          <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
            <div v-if="!appUsers.length" class="px-5 py-8 text-center text-sm text-surface-500">No users with access</div>
            <div v-else class="divide-y divide-surface-800/40">
              <div v-for="ua in appUsers" :key="ua.userId" class="px-5 py-4 flex items-center gap-4 group" :class="{ 'opacity-60': isDeletedUser(ua.userId) }">
                <UserAvatar :name="getUserName(ua.userId)" :image="getUserImage(ua.userId)" size="sm" />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <p class="text-sm font-medium text-surface-200">{{ getUserName(ua.userId) }}</p>
                    <BaseBadge v-if="isDeletedUser(ua.userId)" variant="error" size="sm">{{ t('appDetail.deletedUser') }}</BaseBadge>
                  </div>
                  <p class="text-xs text-surface-500">{{ getUserEmail(ua.userId) }}</p>
                </div>
                <div class="flex items-center gap-2">
                  <BaseBadge variant="neutral" size="sm">{{ getRoleName(ua.roleId) }}</BaseBadge>
                  <BaseBadge variant="neutral" size="sm">{{ getPlanName(ua.subscriptionPlanId) }}</BaseBadge>
                  <BaseBadge :variant="ua.isActive ? 'success' : 'neutral'" size="sm" dot>{{ ua.isActive ? t('common.active') : t('common.inactive') }}</BaseBadge>
                </div>
                <button @click="selectedUserId = ua.userId; showDeleteUserConfirm = true" class="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-red-500 hover:bg-red-500/10 transition-all">
                  <Trash2 class="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="activeTab === 'plans'" class="space-y-4">
          <div class="flex justify-end">
            <BaseButton size="sm" @click="showPlanModal = true"><Plus class="w-3.5 h-3.5" />{{ t('appDetail.createPlan') }}</BaseButton>
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
                  <button @click="openEditPlan(plan)" class="text-xs text-surface-400 hover:text-surface-200 transition-colors">{{ t('common.edit') }}</button>
                  <button @click="priceForm.planId = plan.id; showPriceModal = true" class="text-xs text-primary-400 hover:text-primary-300 transition-colors">+ Price</button>
                </div>
              </div>

              <div v-if="Object.keys(plan.features).length" class="mb-3 flex flex-wrap gap-2">
                <div v-for="{ key, feature } in planFeatureParsed(plan.features)" :key="key" class="px-2.5 py-1 rounded-lg bg-surface-800/60 border border-surface-700/30 text-xs flex items-center gap-1.5">
                  <span class="text-surface-500 font-mono">{{ key }}</span>
                  <template v-if="feature.usage">
                    <BaseBadge variant="warning" size="sm">{{ t('appDetail.metered') }}</BaseBadge>
                    <span class="text-amber-300/80">{{ feature.limit === -1 ? '∞' : feature.limit.toLocaleString() }} {{ feature.unit }}</span>
                    <span v-if="feature.pricePerUnit > 0" class="text-surface-500">· {{ formatPrice(String(feature.pricePerUnit), 'eur') }}/{{ t('appDetail.unit') }}</span>
                  </template>
                  <template v-else>
                    <template v-if="typeof feature.value === 'boolean'">
                      <BaseBadge :variant="feature.value ? 'success' : 'neutral'" size="sm">{{ feature.value ? t('common.enabled') : t('common.disabled') }}</BaseBadge>
                    </template>
                    <template v-else-if="typeof feature.value === 'number'">
                      <span class="text-surface-100 font-semibold">{{ feature.value.toLocaleString() }}</span>
                    </template>
                    <template v-else>
                      <span class="text-surface-300 font-semibold">{{ feature.value }}</span>
                    </template>
                  </template>
                </div>
              </div>

              <div v-if="plan.prices.length" class="space-y-2 pt-3 border-t border-surface-800/40">
                <div v-for="price in plan.prices" :key="price.id" class="flex items-center justify-between text-sm">
                  <span class="text-surface-300">{{ price.name }}</span>
                  <div class="flex items-center gap-3">
                    <span class="font-semibold text-surface-100">{{ formatPrice(price.amount, price.currency) }} / {{ price.interval }}</span>
                    <BaseBadge v-if="price.stripePriceId" variant="success" size="sm">Stripe</BaseBadge>
                    <button @click="appsApi.deletePrice(appId, plan.id, price.id).then(() => appsApi.listPlans(appId).then(r => plans = r.plans))" class="text-red-500 hover:text-red-400 transition-colors">
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="activeTab === 'integration' && app" class="space-y-5 max-w-2xl">
          <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5 space-y-4">
            <CopyField :value="app.slug" :label="t('appDetail.clientId')" />
            <div v-if="!app.isPublic" class="space-y-2">
              <p class="text-xs font-medium text-surface-400 uppercase tracking-wide">{{ t('appDetail.clientSecret') }}</p>
              <div class="flex items-center gap-3">
                <div class="flex-1 px-3 py-2 bg-surface-800/60 border border-surface-700 rounded-lg text-sm font-mono text-surface-500">••••••••••••••••</div>
                <BaseButton variant="outline" size="sm" @click="showRotateConfirm = true">
                  <RefreshCw class="w-3.5 h-3.5" />{{ t('applications.rotateSecret') }}
                </BaseButton>
              </div>
            </div>
            <div>
              <p class="text-xs font-medium text-surface-400 uppercase tracking-wide mb-2">{{ t('appDetail.redirectUris') }}</p>
              <div class="space-y-1.5">
                <div v-for="uri in app.redirectUris" :key="uri" class="px-3 py-1.5 bg-surface-800/60 border border-surface-700/40 rounded-lg font-mono text-xs text-surface-300">{{ uri }}</div>
              </div>
            </div>
            <div>
              <p class="text-xs font-medium text-surface-400 uppercase tracking-wide mb-2">{{ t('appDetail.allowedScopes') }}</p>
              <div class="flex flex-wrap gap-1.5">
                <BaseBadge v-for="scope in app.allowedScopes" :key="scope" variant="neutral" size="sm">{{ scope }}</BaseBadge>
              </div>
            </div>
          </div>

          <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
            <div class="flex items-center gap-2 mb-3">
              <Code class="w-4 h-4 text-primary-400" />
              <p class="text-sm font-semibold text-surface-200">{{ t('appDetail.codeSnippet') }}</p>
            </div>
            <pre class="bg-surface-950/80 rounded-xl p-4 text-xs font-mono text-surface-300 overflow-x-auto border border-surface-800/50 leading-relaxed">{{ codeExampleJS }}</pre>
          </div>

          <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
            <p class="text-sm font-semibold text-surface-200 mb-3">{{ t('appDetail.socialProviders') }}</p>
            <div class="space-y-2">
              <div v-for="key in PROVIDERS" :key="key" class="flex items-center justify-between py-2">
                <p class="text-sm text-surface-300 capitalize">{{ key }}</p>
                <div class="flex items-center gap-2">
                  <BaseBadge
                    v-if="app.enabledSocialProviders === null"
                    :variant="services.config?.providers[key as PKey]?.enabled ? 'success' : 'neutral'"
                    size="sm"
                  >
                    {{ services.config?.providers[key as PKey]?.enabled ? 'Inherited (on)' : 'Inherited (off)' }}
                  </BaseBadge>
                  <BaseBadge
                    v-else
                    :variant="app.enabledSocialProviders?.includes(key) ? 'success' : 'neutral'"
                    size="sm"
                  >
                    {{ app.enabledSocialProviders?.includes(key) ? t('common.enabled') : t('common.disabled') }}
                  </BaseBadge>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="activeTab === 'consumption'" class="space-y-4">
          <div v-if="!consumption.length" class="text-center text-sm text-surface-500 py-8">{{ t('appDetail.noConsumption') }}</div>
          <template v-else>
            <!-- Group by user -->
            <div v-for="ua in appUsers.filter(u => consumption.some(c => c.userId === u.userId))" :key="ua.userId" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
              <div class="px-5 py-3 border-b border-surface-700/40 flex items-center gap-3 bg-surface-800/30">
                <UserAvatar :name="getUserName(ua.userId)" :image="getUserImage(ua.userId)" size="xs" />
                <span class="text-sm font-medium text-surface-200">{{ getUserName(ua.userId) }}</span>
                <BaseBadge v-if="ua.subscriptionPlanId" variant="primary" size="sm">{{ getPlanName(ua.subscriptionPlanId) }}</BaseBadge>
              </div>
              <div class="divide-y divide-surface-800/40">
                <div v-for="agg in consumption.filter(c => c.userId === ua.userId)" :key="agg.key" class="px-5 py-3">
                  <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-2">
                      <code class="text-xs font-mono text-surface-400 bg-surface-800/50 px-1.5 py-0.5 rounded">{{ agg.key }}</code>
                      <!-- Show unit if this key is a metered feature on user's plan -->
                      <template v-if="ua.subscriptionPlanId">
                        <template v-for="plan in plans.filter(p => p.id === ua.subscriptionPlanId)" :key="plan.id">
                          <template v-if="isPlanFeatureMetered(plan.features[agg.key])">
                            <span class="text-xs text-surface-500">{{ (plan.features[agg.key] as any).unit }}</span>
                            <BaseBadge variant="warning" size="sm">{{ t('appDetail.metered') }}</BaseBadge>
                          </template>
                        </template>
                      </template>
                    </div>
                    <div class="flex items-center gap-3">
                      <span class="text-sm font-semibold text-surface-100 tabular-nums">{{ Number(agg.total).toLocaleString() }}</span>
                      <span class="text-xs text-surface-500">{{ formatDate(agg.updatedAt) }}</span>
                      <button @click="selectedMetric = { userId: agg.userId, key: agg.key }; showResetMetricConfirm = true" class="text-xs text-red-500 hover:text-red-400 transition-colors">{{ t('appDetail.resetMetric') }}</button>
                    </div>
                  </div>
                  <!-- Progress bar if there's a limit -->
                  <template v-if="ua.subscriptionPlanId">
                    <template v-for="plan in plans.filter(p => p.id === ua.subscriptionPlanId)" :key="plan.id">
                      <template v-if="isPlanFeatureMetered(plan.features[agg.key]) && (plan.features[agg.key] as any).limit !== -1">
                        <div class="h-1.5 rounded-full bg-surface-800 overflow-hidden">
                          <div
                            :class="['h-full rounded-full transition-all', Number(agg.total) / (plan.features[agg.key] as any).limit >= 1 ? 'bg-red-500' : Number(agg.total) / (plan.features[agg.key] as any).limit >= 0.8 ? 'bg-amber-500' : 'bg-primary-500']"
                            :style="{ width: Math.min(100, (Number(agg.total) / (plan.features[agg.key] as any).limit) * 100) + '%' }"
                          />
                        </div>
                        <div class="flex justify-between text-xs text-surface-500 mt-0.5">
                          <span>{{ Number(agg.total).toLocaleString() }} / {{ (plan.features[agg.key] as any).limit.toLocaleString() }} {{ (plan.features[agg.key] as any).unit }}</span>
                          <span>{{ Math.round((Number(agg.total) / (plan.features[agg.key] as any).limit) * 100) }}%</span>
                        </div>
                      </template>
                    </template>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </div>

        <div v-if="activeTab === 'financial'" class="space-y-5">
          <!-- KPI row -->
          <div class="grid grid-cols-3 gap-4">
            <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
              <p class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">{{ t('appDetail.activeSubscribers') }}</p>
              <p class="text-2xl font-bold text-surface-100">{{ financialKpis.activeSubscribers }}</p>
            </div>
            <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
              <p class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">{{ t('appDetail.mrr') }}</p>
              <p class="text-2xl font-bold text-surface-100">{{ formatPrice(String(financialKpis.mrr), financialKpis.currency) }}</p>
            </div>
            <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
              <p class="text-xs font-semibold text-surface-500 uppercase tracking-wide mb-1">{{ t('appDetail.arr') }}</p>
              <p class="text-2xl font-bold text-surface-100">{{ formatPrice(String(financialKpis.arr), financialKpis.currency) }}</p>
            </div>
          </div>

          <div v-if="!financialKpis.activeSubscribers && !plans.length" class="text-center text-sm text-surface-500 py-8">{{ t('appDetail.noFinancialData') }}</div>
          <template v-else>
            <!-- Revenue by plan -->
            <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
              <div class="px-5 py-3 border-b border-surface-700/40 flex items-center gap-2">
                <TrendingUp class="w-4 h-4 text-surface-400" />
                <h3 class="text-sm font-semibold text-surface-300">{{ t('appDetail.revenueByPlan') }}</h3>
              </div>
              <div v-if="!financialKpis.byPlan.length" class="px-5 py-5 text-sm text-surface-500 text-center">{{ t('appDetail.noFinancialData') }}</div>
              <div v-else class="divide-y divide-surface-800/40">
                <div v-for="row in financialKpis.byPlan" :key="row.name" class="px-5 py-3 flex items-center gap-4">
                  <span class="flex-1 text-sm font-medium text-surface-200">{{ row.name }}</span>
                  <span class="text-xs text-surface-500">{{ row.subscribers }} {{ t('appDetail.subscribers') }}</span>
                  <span class="text-sm font-semibold text-surface-100 tabular-nums">{{ formatPrice(String(row.monthly), row.currency) }}/mo</span>
                </div>
              </div>
            </div>

            <!-- Metered usage aggregate -->
            <div v-if="financialKpis.meteredUsage.length" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
              <div class="px-5 py-3 border-b border-surface-700/40">
                <h3 class="text-sm font-semibold text-surface-300">{{ t('appDetail.meteredUsage') }}</h3>
              </div>
              <div class="divide-y divide-surface-800/40">
                <div v-for="row in financialKpis.meteredUsage" :key="row.key" class="px-5 py-3 flex items-center gap-4">
                  <code class="text-xs font-mono text-surface-400 bg-surface-800/50 px-2 py-0.5 rounded w-36 shrink-0">{{ row.key }}</code>
                  <span class="text-sm text-surface-300 flex-1">{{ row.totalUsage.toLocaleString() }} {{ row.unit }}</span>
                  <span class="text-xs text-surface-500">{{ formatPrice(String(row.pricePerUnit), row.currency) }}/{{ row.unit }}</span>
                  <span class="text-sm font-semibold text-surface-100 tabular-nums">{{ formatPrice(String(row.revenue), row.currency) }}</span>
                </div>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>

    <BaseModal :open="showRoleModal" :title="t('appDetail.createRole')" @close="showRoleModal = false">
      <div class="space-y-4">
        <BaseInput v-model="roleForm.name" label="Name" required />
        <BaseInput v-model="roleForm.description" label="Description" />
        <BaseToggle v-model="roleForm.isDefault" :label="t('appDetail.isDefault')" />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showRoleModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleCreateRole">{{ t('common.create') }}</BaseButton>
      </template>
    </BaseModal>

    <BaseModal :open="showPermModal" :title="t('appDetail.createPermission')" @close="showPermModal = false">
      <div class="space-y-4">
        <BaseInput v-model="permForm.resource" label="Resource" placeholder="documents" required />
        <BaseSelect v-model="permForm.action" label="Action" :options="[{ value: 'read', label: 'read' }, { value: 'write', label: 'write' }]" />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showPermModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleCreatePerm">{{ t('common.create') }}</BaseButton>
      </template>
    </BaseModal>

    <BaseModal :open="showUserModal" :title="t('appDetail.grantAccess')" @close="showUserModal = false">
      <div class="space-y-4">
        <BaseSelect v-model="userForm.userId" label="User" :options="userOptions" placeholder="Select a user" />
        <BaseSelect v-model="userForm.roleId" label="Role" :options="roleOptions" placeholder="Default role" />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showUserModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleGrantAccess">{{ t('appDetail.grantAccess') }}</BaseButton>
      </template>
    </BaseModal>

    <BaseModal :open="showPlanModal" :title="editingPlanId ? t('appDetail.editPlan') : t('appDetail.createPlan')" @close="closePlanModal">
      <div class="space-y-4">
        <BaseInput v-model="planForm.name" label="Name" required />
        <BaseInput v-model="planForm.description" label="Description" />
        <BaseToggle v-model="planForm.isDefault" label="Default plan" />
        <div>
          <p class="text-xs font-medium text-surface-400 uppercase tracking-wide mb-1.5">{{ t('appDetail.features') }}</p>
          <div class="space-y-2">
            <div v-for="(entry, i) in planFeatureEntries" :key="i" class="rounded-xl bg-surface-800/40 border border-surface-700/30 p-3 space-y-2.5">
              <div class="flex items-center gap-2">
                <BaseInput v-model="entry.key" placeholder="feature.key" class="flex-1 min-w-0" />
                <div class="flex items-center gap-1.5 shrink-0">
                  <span class="text-xs text-surface-400">{{ t('appDetail.metered') }}</span>
                  <BaseToggle v-model="entry.usage" />
                </div>
                <button type="button" @click="planFeatureEntries.splice(i, 1)" class="p-1.5 rounded-lg text-surface-500 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0">
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>
              <template v-if="entry.usage">
                <div class="grid grid-cols-3 gap-2">
                  <BaseInput v-model="entry.limit" :label="t('appDetail.limit')" type="number" placeholder="-1" />
                  <BaseInput v-model="entry.unit" :label="t('appDetail.unit')" placeholder="tokens" />
                  <BaseInput v-model="entry.pricePerUnit" :label="t('appDetail.pricePerUnit')" type="number" placeholder="0" />
                </div>
                <p class="text-xs text-surface-500">{{ t('appDetail.limitHint') }}</p>
              </template>
              <template v-else>
                <BaseInput v-model="entry.value" :label="t('common.value')" placeholder="true / 100 / text" />
              </template>
            </div>
            <BaseButton variant="ghost" size="sm" @click="planFeatureEntries.push({ key: '', usage: false, value: '', limit: '-1', unit: '', pricePerUnit: '0' })">
              <Plus class="w-3.5 h-3.5" /> {{ t('appDetail.addFeature') }}
            </BaseButton>
          </div>
        </div>
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="closePlanModal">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleSavePlan">{{ editingPlanId ? t('common.save') : t('common.create') }}</BaseButton>
      </template>
    </BaseModal>

    <BaseModal :open="showPriceModal" :title="t('appDetail.addPrice')" @close="showPriceModal = false">
      <div class="space-y-4">
        <BaseInput v-model="priceForm.name" label="Name" required />
        <div class="grid grid-cols-2 gap-3">
          <BaseInput v-model="priceForm.amount" label="Amount (cents)" type="number" required />
          <BaseInput v-model="priceForm.currency" label="Currency" placeholder="eur" />
        </div>
        <BaseSelect v-model="priceForm.interval" label="Interval" :options="intervalOptions" />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showPriceModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleAddPrice">{{ t('appDetail.addPrice') }}</BaseButton>
      </template>
    </BaseModal>

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

    <ConfirmDialog :open="showDeleteRoleConfirm" :title="t('appDetail.deleteRole')" message="Are you sure you want to delete this role?" :loading="formLoading" @confirm="handleDeleteRole" @cancel="showDeleteRoleConfirm = false" />
    <ConfirmDialog :open="showDeleteUserConfirm" :title="t('appDetail.revokeAccess')" message="Revoke this user's access to the application?" :loading="formLoading" @confirm="handleRevokeAccess" @cancel="showDeleteUserConfirm = false" />
    <ConfirmDialog :open="showResetMetricConfirm" :title="t('appDetail.resetMetric')" :message="t('appDetail.confirmResetMetric')" :loading="formLoading" @confirm="handleResetMetric" @cancel="showResetMetricConfirm = false" />
    <ConfirmDialog :open="showRotateConfirm" :title="t('applications.rotateSecret')" :message="t('applications.rotateSecretConfirm')" :loading="formLoading" @confirm="handleRotate" @cancel="showRotateConfirm = false" />
    <ConfirmDialog :open="showDeletePermConfirm" :title="t('appDetail.deletePermission')" message="Delete this permission?" :loading="formLoading" @confirm="async () => { if (selectedPermId) { await appsApi.deletePermission(appId, selectedPermId); permissions = (await appsApi.listPermissions(appId)).permissions; showDeletePermConfirm = false; } }" @cancel="showDeletePermConfirm = false" />
    <ConfirmDialog :open="showDeletePlanConfirm" :title="t('appDetail.deletePlan')" message="Delete this plan?" :loading="formLoading" @confirm="async () => { if (selectedPlanId) { await appsApi.deletePlan(appId, selectedPlanId); plans = (await appsApi.listPlans(appId)).plans; showDeletePlanConfirm = false; } }" @cancel="showDeletePlanConfirm = false" />
  </AppLayout>
</template>
