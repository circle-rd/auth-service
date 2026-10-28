<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useServicesStore } from '@/stores/services';
import * as appsApi from '@/api/applications';
import * as consumptionApi from '@/api/consumption';
import { listUsers } from '@/api/users';
import { listOrganizations } from '@/api/organizations';
import { useToast } from '@/composables/useToast';
import { useAdminEvents } from '@/composables/useAdminEvents';
import { rotateSecret } from '@/api/applications';
import type { Application, AppRole, AppPermission, SubscriptionPlan, SubscriptionPlanPrice, UserApplication, ConsumptionAggregate } from '@/types';
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
import ApplicationInvitationsTab from '@/components/applications/ApplicationInvitationsTab.vue';
import { parseUserAgent } from '@/composables/useUserAgent';
import Sparkline from '@/components/ui/Sparkline.vue';
import { getApplicationsActivity, getLogins, type AppActivityEntry } from '@/api/stats';
import type { ColumnDef, DataTablePagination } from '@/types/data-table';
import { usePersistentPageSize } from '@/composables/usePersistentPageSize';
import { useDebounce } from '@/composables/useDebounce';
import { ArrowLeft, Plus, Trash2, RefreshCw, Check, AlertTriangle, Code, TrendingUp, History, Activity, Copy, Users, CreditCard, Building2, Shield, Ban, Star, Mail } from 'lucide-vue-next';
import type { SelectOption } from '@/types/select';
import { SCOPE_CATALOGUE } from '@/components/applications/form/scopes';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const toast = useToast();
const services = useServicesStore();

const appId = route.params.id as string;
const activeTab = ref<'roles' | 'users' | 'plans' | 'invitations' | 'integration' | 'consumption' | 'financial'>('roles');
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
const events = useAdminEvents({
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
});

// The online counter drifts down on its own (session expiry), so the activity
// strip is also polled — same 30 s cadence as the dashboard.
let activityPollHandle: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await services.fetch();
  await loadAll();
  void loadAppActivity();
  activityPollHandle = setInterval(() => void loadAppActivity(), 30_000);
});

onUnmounted(() => {
  events.close();
  if (activityPollHandle) clearInterval(activityPollHandle);
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

/** The application's default plan id, used to preselect the selector. */
function defaultPlanId(): string {
  return plans.value.find((p) => p.isDefault)?.id ?? '';
}

function openGrantModal() {
  userForm.value = { userId: '', roleId: '', subscriptionPlanId: defaultPlanId() };
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

/** The metered price that bills a feature of a plan, or null. */
function meteredPriceOf(plan: SubscriptionPlan | undefined, key: string): SubscriptionPlanPrice | null {
  return plan?.prices.find((p) => p.billingType === 'metered' && p.featureKey === key) ?? null;
}

/** Share of a metered feature's cap already used, with its colour; null when uncapped. */
function usageOf(plan: SubscriptionPlan | undefined, key: string, total: string): { ratio: number; cls: string; price: SubscriptionPlanPrice } | null {
  const price = meteredPriceOf(plan, key);
  if (!price || price.usageLimit === null || price.usageLimit < 0) return null;
  const used = Number(total);
  const ratio = price.usageLimit === 0 ? (used > 0 ? 1 : 0) : used / price.usageLimit;
  const cls = ratio >= 1 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-primary-500';
  return { ratio, cls, price };
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
  return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 0 }).format(Number(amount) / 100);
}

function formatDate(iso: string) { return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }); }

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

const tabs = [
  { key: 'roles', label: t('appDetail.rolesPermissions') },
  { key: 'users', label: t('appDetail.users') },
  { key: 'plans', label: t('appDetail.plans') },
  { key: 'invitations', label: t('appDetail.invitations') },
  { key: 'integration', label: t('appDetail.integration') },
  { key: 'consumption', label: t('appDetail.consumption') },
  { key: 'financial', label: t('appDetail.financial') },
] as const;

const activeCodeTab = ref<'typescript' | 'python' | 'ioserver'>('typescript');

// Auth-service URL = origin of this SPA (same server)
const authServiceUrl = computed(() => window.location.origin);

const codeExampleTS = computed(() => {
  if (!app.value) return '';
  const redirectUri = app.value.redirectUris[0] ?? 'https://your-app.com/callback';
  const audience = app.value.url ?? 'https://your-app.com';
  const scope = app.value.allowedScopes.join(' ');
  return `import * as oauth from 'oauth4webapi';

const issuer = new URL('${authServiceUrl.value}');
const as = await oauth.discoveryRequest(issuer).then(r => oauth.processDiscoveryResponse(issuer, r));

const client: oauth.Client = { client_id: '${app.value.slug}' };

// 1. Build authorization URL (PKCE + RFC 8707 resource)
const codeVerifier = oauth.generateRandomCodeVerifier();
const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

const authUrl = new URL(as.authorization_endpoint!);
authUrl.searchParams.set('client_id', '${app.value.slug}');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('redirect_uri', '${redirectUri}');
authUrl.searchParams.set('scope', '${scope}');
authUrl.searchParams.set('resource', '${audience}');  // RFC 8707
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('state', oauth.generateRandomState());

window.location.href = authUrl.toString();

// 2. Exchange code for tokens (in your /callback handler)
const currentUrl = new URL(window.location.href);
const params = oauth.validateAuthResponse(as, client, currentUrl, expectedState);
const response = await oauth.authorizationCodeGrantRequest(
  as, client, oauth.None(), params,
  '${redirectUri}', codeVerifier,
  { additionalParameters: new URLSearchParams({ resource: '${audience}' }) },
);
const tokens = await oauth.processAuthorizationCodeResponse(as, client, response);
console.log(tokens.access_token);`;
});

const codeExamplePython = computed(() => {
  if (!app.value) return '';
  const redirectUri = app.value.redirectUris[0] ?? 'https://your-app.com/callback';
  const audience = app.value.url ?? 'https://your-app.com';
  const scope = app.value.allowedScopes.join(' ');
  return `from authlib.integrations.requests_client import OAuth2Session
import secrets, hashlib, base64

client_id = '${app.value.slug}'
redirect_uri = '${redirectUri}'
scope = '${scope}'
resource = '${audience}'  # RFC 8707

# PKCE helpers
verifier = secrets.token_urlsafe(64)
challenge = base64.urlsafe_b64encode(
    hashlib.sha256(verifier.encode()).digest()
).rstrip(b'=').decode()

client = OAuth2Session(
    client_id, scope=scope, redirect_uri=redirect_uri,
    code_challenge_method='S256',
)

# 1. Redirect user to authorization URL
authorization_endpoint = '${authServiceUrl.value}/api/auth/oauth2/authorize'
uri, state = client.create_authorization_url(
    authorization_endpoint,
    code_verifier=verifier,
    resource=resource,
)
print('Redirect to:', uri)

# 2. Exchange code for tokens (after callback)
token_endpoint = '${authServiceUrl.value}/api/auth/oauth2/token'
tokens = client.fetch_token(
    token_endpoint,
    authorization_response=callback_url,
    code_verifier=verifier,
    resource=resource,
)
print(tokens['access_token'])`;
});

const codeExampleIOServer = computed(() => {
  if (!app.value) return '';
  const audience = app.value.url ?? 'https://your-app.com';
  return `# .env
AUTH_SERVICE_URL=${authServiceUrl.value}
AUTH_SERVICE_APP_SLUG=${app.value.slug}
AUTH_SERVICE_AUDIENCE=${audience}  # JWT aud claim = resource URL

# --- src/index.ts ---
import {
  OidcConfigManager,
  OidcHttpMiddleware,
  OidcSocketMiddleware,
} from 'ioserver-oidc';

// Register the OIDC config manager (reads env vars above)
server.addManager({ name: 'oidcConfig', manager: OidcConfigManager });

// Protect HTTP routes
server.addController({
  name: 'api',
  controller: ApiController,
  middlewares: [OidcHttpMiddleware],
  prefix: '/api',
});

// Protect Socket.IO namespaces
server.addService({
  name: 'events',
  service: EventService,
  middlewares: [OidcSocketMiddleware],
});

// Inside a controller/service handler:
// request.sub         → OIDC subject (stable user ID)
// request.roles       → string[]  (from \'roles\' scope)
// request.permissions → string[]  (from \'permissions\' scope)
// request.features    → object    (from 'features' scope)`;
});

const codeCopied = ref(false);
let codeCopiedTimer: ReturnType<typeof setTimeout> | undefined;
const activeCodeExample = computed(() =>
  activeCodeTab.value === 'typescript'
    ? codeExampleTS.value
    : activeCodeTab.value === 'python'
      ? codeExamplePython.value
      : codeExampleIOServer.value,
);
async function copyActiveCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(activeCodeExample.value);
    codeCopied.value = true;
    toast.success(t('common.copied'));
    clearTimeout(codeCopiedTimer);
    codeCopiedTimer = setTimeout(() => {
      codeCopied.value = false;
    }, 1500);
  } catch {
    toast.error(t('common.copyError'));
  }
}

const PROVIDERS = ['google', 'github', 'linkedin', 'microsoft', 'apple'] as const;
type PKey = typeof PROVIDERS[number];

const consumptionUsers = computed(() => {
  const byUser = new Map<string, { userId: string; name: string; email: string | null; image: string | null; subscriptionPlanId: string | null }>();
  for (const entry of consumption.value) {
    if (byUser.has(entry.userId)) continue;
    const pageUser = appUsers.value.find((u) => u.userId === entry.userId);
    byUser.set(entry.userId, {
      userId: entry.userId,
      name: entry.userName ?? pageUser?.name ?? entry.userEmail ?? entry.userId,
      email: entry.userEmail ?? pageUser?.email ?? null,
      image: pageUser?.image ?? null,
      subscriptionPlanId: entry.subscriptionPlanId ?? pageUser?.subscriptionPlanId ?? null,
    });
  }
  return [...byUser.values()];
});

const financialKpis = computed(() => {
  const subscribedUsers = appSubscriptions.value;
  const activeSubscribers = subscribedUsers.filter((s) => s.isActive).length;

  let mrr = 0;
  const planRevenue: Record<string, { name: string; subscribers: number; monthly: number; currency: string }> = {};

  for (const subscription of subscribedUsers) {
    const plan = plans.value.find(p => p.id === subscription.planId);
    if (!plan) continue;
    const price = plan.prices.find(p => p.billingType === 'fixed' && p.interval === 'month');
    const amount = price ? Number(price.amount) : 0;
    const currency = price?.currency ?? 'eur';
    mrr += amount;

    if (!planRevenue[plan.id]) planRevenue[plan.id] = { name: plan.name, subscribers: 0, monthly: 0, currency };
    planRevenue[plan.id].subscribers += 1;
    planRevenue[plan.id].monthly += amount;
  }

  // Metered usage per feature, priced by the metered price rows of each plan
  const meteredKeys = new Map<string, { unit: string; totalUsage: number; pricePerUnit: number; revenue: number; currency: string }>();
  for (const plan of plans.value) {
    for (const price of plan.prices) {
      const key = price.featureKey;
      if (price.billingType !== 'metered' || !key) continue;
      const unitPrice = Number(price.amount);
      if (!meteredKeys.has(key)) meteredKeys.set(key, { unit: price.unit ?? '', totalUsage: 0, pricePerUnit: unitPrice, revenue: 0, currency: price.currency });
      for (const subscription of subscribedUsers.filter((s) => s.planId === plan.id)) {
        const agg = consumption.value.find(c => c.userId === subscription.userId && c.key === key);
        if (!agg) continue;
        const entry = meteredKeys.get(key)!;
        entry.totalUsage += Number(agg.total);
        entry.revenue += Number(agg.total) * unitPrice;
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

      <div v-if="appActivity" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 px-5 py-3 flex items-center justify-between gap-5">
        <div class="flex items-center gap-5 text-sm">
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
        <Sparkline :values="appActivity.sparkline" :width="140" :height="32" />
      </div>

      <div class="flex gap-1 p-1 bg-surface-900/60 rounded-xl border border-surface-700/40 overflow-x-auto -mx-6 sm:mx-0 px-6 sm:px-0 scroll-smooth snap-x snap-mandatory">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          @click="activeTab = tab.key"
          :class="['px-3 py-1.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap snap-start', activeTab === tab.key ? 'bg-primary-600/20 text-primary-300 shadow-sm' : 'text-surface-500 hover:text-surface-300']"
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

        <div v-if="activeTab === 'users'" class="space-y-4">
          <div class="flex justify-end gap-2">
            <BaseButton size="sm" @click="openInviteFromUsers"><Mail class="w-3.5 h-3.5" />{{ t('appDetail.inviteUser') }}</BaseButton>
            <BaseButton size="sm" variant="outline" @click="openGrantModal"><Plus class="w-3.5 h-3.5" />{{ t('appDetail.grantAccess') }}</BaseButton>
            <BaseButton size="sm" variant="outline" @click="openBulkModal"><Users class="w-3.5 h-3.5" />{{ t('appDetail.bulkGrantAccess') }}</BaseButton>
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

        <div v-if="activeTab === 'integration' && app" class="grid grid-cols-1 xl:grid-cols-2 gap-5">

          <!-- ── Credentials ────────────────────────────────────────────── -->
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
            <CopyField
              v-if="app.url"
              :value="app.url"
              label="Resource / Audience"
            />
            <div v-else class="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
              <span class="shrink-0 mt-0.5">⚠</span>
              <span>No application URL configured — the <code class="font-mono bg-amber-500/10 px-1 rounded">resource</code> parameter (RFC 8707) is required to receive JWT access tokens. Set the URL in the application settings.</span>
            </div>
            <CopyField
              :value="`${authServiceUrl}/api/auth/jwks`"
              label="JWKS URI"
            />
            <CopyField
              :value="`${authServiceUrl}/api/auth/.well-known/openid-configuration`"
              label="Discovery Endpoint"
            />
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

          <!-- ── Code Examples ──────────────────────────────────────────── -->
          <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5 flex flex-col">
            <div class="flex items-center gap-2 mb-4">
              <Code class="w-4 h-4 text-primary-400" />
              <p class="text-sm font-semibold text-surface-200">{{ t('appDetail.codeSnippet') }}</p>
              <button
                type="button"
                class="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-surface-400 hover:text-surface-100 hover:bg-surface-800/60 transition-colors"
                :title="t('common.copy')"
                @click="copyActiveCode"
              >
                <component :is="codeCopied ? Check : Copy" class="w-3.5 h-3.5" />
                {{ codeCopied ? t('common.copied') : t('common.copy') }}
              </button>
            </div>
            <div class="flex gap-1 p-1 bg-surface-950/60 rounded-lg border border-surface-800/50 w-fit mb-4">
              <button
                v-for="tab in [{ key: 'typescript', label: 'TypeScript' }, { key: 'python', label: 'Python' }, { key: 'ioserver', label: 'IOServer' }]"
                :key="tab.key"
                @click="activeCodeTab = tab.key as 'typescript' | 'python' | 'ioserver'"
                :class="['px-3 py-1 rounded-md text-xs font-medium transition-all', activeCodeTab === tab.key ? 'bg-primary-600/20 text-primary-300' : 'text-surface-500 hover:text-surface-300']"
              >{{ tab.label }}</button>
            </div>
            <pre class="flex-1 min-h-0 overflow-auto bg-surface-950/80 rounded-xl p-4 text-xs font-mono text-surface-300 border border-surface-800/50 leading-relaxed whitespace-pre">{{ activeCodeExample }}</pre>
            <p v-if="activeCodeTab === 'typescript'" class="mt-2 text-xs text-surface-500">Uses <code class="font-mono">oauth4webapi</code> — <code class="font-mono">npm i oauth4webapi</code></p>
            <p v-else-if="activeCodeTab === 'python'" class="mt-2 text-xs text-surface-500">Uses <code class="font-mono">authlib</code> — <code class="font-mono">pip install authlib requests</code></p>
            <p v-else class="mt-2 text-xs text-surface-500">Uses <code class="font-mono">ioserver-oidc</code> — <code class="font-mono">npm i ioserver-oidc</code> — no secret storage needed on the app side</p>
          </div>

          <!-- ── Scopes & Claims ────────────────────────────────────────── -->
          <div class="rounded-2xl bg-surface-900/60 border border-surface-700/40 p-5">
            <p class="text-sm font-semibold text-surface-200 mb-3">Scopes &amp; Claims</p>
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead>
                  <tr class="border-b border-surface-800/40">
                    <th class="text-left py-2 pr-4 text-surface-500 font-medium w-32">Scope</th>
                    <th class="text-left py-2 pr-4 text-surface-500 font-medium w-24">Type</th>
                    <th class="text-left py-2 text-surface-500 font-medium">Claims returned</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-surface-800/30">
                  <tr v-for="info in SCOPE_CATALOGUE" :key="info.scope">
                    <td class="py-2 pr-4">
                      <code :class="['font-mono px-1.5 py-0.5 rounded text-xs', app.allowedScopes.includes(info.scope) ? 'bg-primary-600/15 text-primary-300' : 'bg-surface-800/50 text-surface-500']">{{ info.scope }}</code>
                    </td>
                    <td class="py-2 pr-4">
                      <BaseBadge :variant="info.group === 'standard' ? 'success' : 'neutral'" size="sm">{{ info.group === 'standard' ? 'Standard OIDC' : 'Custom' }}</BaseBadge>
                    </td>
                    <td class="py-2 text-surface-400 font-mono">{{ info.claims }}</td>
                  </tr>
                </tbody>
              </table>
              <p class="mt-2 text-xs text-surface-600">* <code class="font-mono">company</code> is a proprietary claim inside the standard <code class="font-mono">profile</code> scope.</p>
            </div>
          </div>

          <!-- ── Social Providers ───────────────────────────────────────── -->
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
            <div v-for="ua in consumptionUsers" :key="ua.userId" class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
              <div class="px-5 py-3 border-b border-surface-700/40 flex items-center gap-3 bg-surface-800/30">
                <UserAvatar :name="ua.name" :image="ua.image" size="xs" />
                <span class="text-sm font-medium text-surface-200">{{ ua.name }}</span>
                <BaseBadge v-if="ua.subscriptionPlanId" variant="primary" size="sm">{{ getPlanName(ua.subscriptionPlanId) }}</BaseBadge>
              </div>
              <div class="divide-y divide-surface-800/40">
                <div v-for="agg in consumption.filter(c => c.userId === ua.userId)" :key="agg.key" class="px-5 py-3">
                  <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-2">
                      <code class="text-xs font-mono text-surface-400 bg-surface-800/50 px-1.5 py-0.5 rounded">{{ agg.key }}</code>
                      <!-- Unit when this key is a metered price of the user's plan -->
                      <template v-if="ua.subscriptionPlanId">
                        <template v-for="plan in plans.filter(p => p.id === ua.subscriptionPlanId)" :key="plan.id">
                          <template v-if="meteredPriceOf(plan, agg.key)">
                            <span class="text-xs text-surface-500">{{ meteredPriceOf(plan, agg.key)?.unit }}</span>
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
                  <!-- Progress bar against the cap of the metered price -->
                  <template v-if="ua.subscriptionPlanId">
                    <template v-for="plan in plans.filter(p => p.id === ua.subscriptionPlanId)" :key="plan.id">
                      <template v-if="usageOf(plan, agg.key, agg.total)">
                        <div class="h-1.5 rounded-full bg-surface-800 overflow-hidden">
                          <div
                            :class="['h-full rounded-full transition-all', usageOf(plan, agg.key, agg.total)?.cls]"
                            :style="{ width: Math.min(100, (usageOf(plan, agg.key, agg.total)?.ratio ?? 0) * 100) + '%' }"
                          />
                        </div>
                        <div class="flex justify-between text-xs text-surface-500 mt-0.5">
                          <span>{{ Number(agg.total).toLocaleString() }} / {{ usageOf(plan, agg.key, agg.total)?.price.usageLimit?.toLocaleString() }} {{ usageOf(plan, agg.key, agg.total)?.price.unit }}</span>
                          <span>{{ Math.round((usageOf(plan, agg.key, agg.total)?.ratio ?? 0) * 100) }}%</span>
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
