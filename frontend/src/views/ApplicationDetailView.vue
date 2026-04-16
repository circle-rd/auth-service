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
import { ArrowLeft, Plus, Trash2, RefreshCw, Check, X, AlertTriangle, Code } from 'lucide-vue-next';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const toast = useToast();
const services = useServicesStore();

const appId = route.params.id as string;
const activeTab = ref<'roles' | 'users' | 'plans' | 'integration' | 'consumption'>('roles');

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
const planForm = ref({ name: '', description: '', isDefault: false, features: '{}' });
const priceForm = ref({ name: '', amount: '', currency: 'eur', interval: 'month' as 'month' | 'year' | 'one_time', planId: '' });

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

async function handleCreatePlan() {
  formLoading.value = true;
  try {
    let features: Record<string, unknown> = {};
    try { features = JSON.parse(planForm.value.features); } catch { /* ignore */ }
    await appsApi.createPlan(appId, { name: planForm.value.name, description: planForm.value.description, isDefault: planForm.value.isDefault, features });
    plans.value = (await appsApi.listPlans(appId)).plans;
    toast.success('Plan created');
    showPlanModal.value = false;
    planForm.value = { name: '', description: '', isDefault: false, features: '{}' };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed');
  } finally {
    formLoading.value = false;
  }
}

async function handleAddPrice() {
  if (!priceForm.value.planId || !priceForm.value.amount) return;
  formLoading.value = true;
  try {
    await appsApi.createPrice(appId, priceForm.value.planId, { name: priceForm.value.name, amount: priceForm.value.amount, currency: priceForm.value.currency, interval: priceForm.value.interval });
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

function getUserName(userId: string) { return allUsers.value.find(u => u.id === userId)?.name ?? userId; }
function getUserEmail(userId: string) { return allUsers.value.find(u => u.id === userId)?.email ?? ''; }
function getUserImage(userId: string) { return allUsers.value.find(u => u.id === userId)?.image ?? null; }
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
              <div v-for="ua in appUsers" :key="ua.userId" class="px-5 py-4 flex items-center gap-4 group">
                <UserAvatar :name="getUserName(ua.userId)" :image="getUserImage(ua.userId)" size="sm" />
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-surface-200">{{ getUserName(ua.userId) }}</p>
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
                <button @click="priceForm.planId = plan.id; showPriceModal = true" class="text-xs text-primary-400 hover:text-primary-300 transition-colors">+ Price</button>
              </div>

              <div v-if="Object.keys(plan.features).length" class="mb-3 flex flex-wrap gap-2">
                <div v-for="[k, v] in Object.entries(plan.features)" :key="k" class="px-2.5 py-1 rounded-lg bg-surface-800/60 border border-surface-700/30 text-xs">
                  <span class="text-surface-500 font-mono">{{ k }}: </span>
                  <span class="text-surface-300 font-semibold">{{ v }}</span>
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
          <div v-else class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
            <div class="overflow-x-auto">
              <table class="w-full">
                <thead>
                  <tr class="border-b border-surface-700/40 bg-surface-800/30">
                    <th class="px-4 py-3 text-left text-xs font-medium text-surface-500 uppercase tracking-wide">User</th>
                    <th class="px-4 py-3 text-left text-xs font-medium text-surface-500 uppercase tracking-wide">Metric</th>
                    <th class="px-4 py-3 text-right text-xs font-medium text-surface-500 uppercase tracking-wide">Total</th>
                    <th class="px-4 py-3 text-right text-xs font-medium text-surface-500 uppercase tracking-wide">Updated</th>
                    <th class="px-4 py-3 text-right text-xs font-medium text-surface-500 uppercase tracking-wide"></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-surface-800/40">
                  <tr v-for="agg in consumption" :key="`${agg.userId}-${agg.key}`" class="hover:bg-surface-800/20 transition-colors">
                    <td class="px-4 py-3">
                      <div class="flex items-center gap-2">
                        <UserAvatar :name="getUserName(agg.userId)" :image="getUserImage(agg.userId)" size="xs" />
                        <span class="text-sm text-surface-300">{{ getUserName(agg.userId) }}</span>
                      </div>
                    </td>
                    <td class="px-4 py-3"><code class="text-xs font-mono text-surface-400 bg-surface-800/50 px-1.5 py-0.5 rounded">{{ agg.key }}</code></td>
                    <td class="px-4 py-3 text-right"><span class="text-sm font-semibold text-surface-100 tabular-nums">{{ Number(agg.total).toLocaleString() }}</span></td>
                    <td class="px-4 py-3 text-right"><span class="text-xs text-surface-500">{{ formatDate(agg.updatedAt) }}</span></td>
                    <td class="px-4 py-3 text-right">
                      <button @click="selectedMetric = { userId: agg.userId, key: agg.key }; showResetMetricConfirm = true" class="text-xs text-red-500 hover:text-red-400 transition-colors">{{ t('appDetail.resetMetric') }}</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
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

    <BaseModal :open="showPlanModal" :title="t('appDetail.createPlan')" @close="showPlanModal = false">
      <div class="space-y-4">
        <BaseInput v-model="planForm.name" label="Name" required />
        <BaseInput v-model="planForm.description" label="Description" />
        <BaseToggle v-model="planForm.isDefault" label="Default plan" />
        <div>
          <p class="text-xs font-medium text-surface-400 uppercase tracking-wide mb-1.5">Features (JSON)</p>
          <textarea v-model="planForm.features" rows="4" class="w-full px-3 py-2 text-sm font-mono bg-surface-800 border border-surface-600 rounded-lg text-surface-100 focus:outline-none focus:ring-2 focus:ring-primary-500/50 resize-none" />
        </div>
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showPlanModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleCreatePlan">{{ t('common.create') }}</BaseButton>
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
