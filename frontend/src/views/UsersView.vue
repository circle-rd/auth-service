<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useUsersStore } from '@/stores/users';
import { createUser, disableUser, enableUser } from '@/api/users';
import { useToast } from '@/composables/useToast';
import { useDebounce } from '@/composables/useDebounce';
import type { User } from '@/types';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import EntityModal from '@/components/ui/EntityModal.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import DataTable from '@/components/ui/DataTable.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppIconStack from '@/components/ui/AppIconStack.vue';
import { UserPlus, Search, CheckCircle, XCircle, Shield, ShieldAlert, User as UserIcon, MoreHorizontal, Eye, Pencil, Trash2, Ban, CheckCircle2 } from 'lucide-vue-next';
import type { ColumnDef } from '@/types/data-table';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const router = useRouter();
const store = useUsersStore();
const auth = useAuthStore();
const toast = useToast();

const search = ref('');
const debouncedSearch = useDebounce(search);
const filterRole = ref('');
const filterStatus = ref('');
const page = ref(1);

const showCreateModal = ref(false);
const showEditModal = ref(false);
const showDeleteConfirm = ref(false);
const showDisableConfirm = ref(false);
const deleteLoading = ref(false);
const actionLoading = ref(false);
const deleteError = ref('');
const selectedUser = ref<User | null>(null);
const actionMenuUser = ref<string | null>(null);

const createForm = ref({ name: '', email: '', password: '', role: 'user' as 'user' | 'admin' });
const editForm = ref({ name: '', role: 'user' as 'user' | 'admin', isMfaRequired: undefined as boolean | undefined });
const formLoading = ref(false);
const formError = ref('');

onMounted(() => loadUsers());

watch([debouncedSearch, filterRole, filterStatus], () => {
  page.value = 1;
  loadUsers();
});

async function loadUsers() {
  await store.fetchUsers({ page: page.value, limit: 20, search: debouncedSearch.value });
}

const filteredUsers = computed(() => {
  let list = store.users;
  if (filterRole.value) list = list.filter(u => u.role === filterRole.value);
  if (filterStatus.value === 'banned') list = list.filter(u => u.banned);
  if (filterStatus.value === 'active') list = list.filter(u => !u.banned);
  return list;
});

const roleOptions = [
  { value: '', label: t('users.allRoles') },
  { value: 'superadmin', label: t('users.superadmin') },
  { value: 'admin', label: t('users.admin') },
  { value: 'user', label: t('users.user') },
];

const statusOptions = [
  { value: '', label: t('users.allStatuses') },
  { value: 'active', label: t('common.active') },
  { value: 'banned', label: t('users.banned') },
];

function roleBadgeVariant(role: string | null) {
  if (role === 'superadmin') return 'error' as const;
  if (role === 'admin') return 'warning' as const;
  return 'neutral' as const;
}

// Role options for create/edit: superadmin is never assignable via UI (env-only).
// Only superadmins can see and assign the admin role.
const assignableRoleOptions = computed(() => {
  const opts: { value: string; label: string }[] = [{ value: 'user', label: t('users.user') }];
  if (auth.isSuperAdmin()) opts.push({ value: 'admin', label: t('users.admin') });
  return opts;
});

function openEdit(user: User) {
  selectedUser.value = user;
  // If target is superadmin, show as read-only (role won't be in assignable options)
  const role = (user.role === 'admin' ? 'admin' : 'user') as 'user' | 'admin';
  editForm.value = { name: user.name, role, isMfaRequired: user.isMfaRequired ?? undefined };
  showEditModal.value = true;
  actionMenuUser.value = null;
}

function openDelete(user: User) {
  selectedUser.value = user;
  deleteError.value = '';
  showDeleteConfirm.value = true;
  actionMenuUser.value = null;
}

async function handleCreate() {
  if (!createForm.value.name || !createForm.value.email || !createForm.value.password) {
    formError.value = 'All fields are required';
    return;
  }
  formLoading.value = true;
  formError.value = '';
  try {
    await createUser(createForm.value);
    toast.success('User created successfully');
    showCreateModal.value = false;
    createForm.value = { name: '', email: '', password: '', role: 'user' as 'user' | 'admin' };
    await loadUsers();
  } catch (err) {
    formError.value = err instanceof Error ? err.message : 'Failed to create user';
  } finally {
    formLoading.value = false;
  }
}

async function handleEdit() {
  if (!selectedUser.value) return;
  formLoading.value = true;
  formError.value = '';
  try {
    await store.updateUser(selectedUser.value.id, editForm.value);
    toast.success('User updated');
    showEditModal.value = false;
  } catch (err) {
    formError.value = err instanceof Error ? err.message : 'Failed to update user';
  } finally {
    formLoading.value = false;
  }
}

async function handleDelete() {
  if (!selectedUser.value) return;
  deleteLoading.value = true;
  deleteError.value = '';
  try {
    await store.deleteUser(selectedUser.value.id);
    toast.success('User deleted');
    showDeleteConfirm.value = false;
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : 'Failed to delete user';
  } finally {
    deleteLoading.value = false;
  }
}

async function handleUnban(user: User) {
  actionLoading.value = true;
  try {
    await enableUser(user.id);
    await store.updateUser(user.id, { banned: false });
    toast.success('User unbanned');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to unban user');
  } finally {
    actionLoading.value = false;
    actionMenuUser.value = null;
  }
}

function openDisable(user: User) {
  selectedUser.value = user;
  showDisableConfirm.value = true;
  actionMenuUser.value = null;
}

async function handleDisable() {
  if (!selectedUser.value) return;
  actionLoading.value = true;
  try {
    await disableUser(selectedUser.value.id);
    await store.updateUser(selectedUser.value.id, { banned: true });
    toast.success('User disabled');
    showDisableConfirm.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to disable user');
  } finally {
    actionLoading.value = false;
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function formatLastLogin(iso: string | null | undefined): string {
  if (!iso) return t('users.never');
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

const userColumns = computed<ColumnDef<User>[]>(() => [
  { key: 'name', label: t('users.columns.name'), field: 'name', sortable: true },
  { key: 'role', label: t('users.columns.role'), field: 'role', sortable: true, responsive: 'sm' },
  { key: 'applications', label: t('users.columns.applications'), responsive: 'md', accessor: (r) => r.applications?.length ?? 0 },
  { key: 'lastLogin', label: t('users.columns.lastLogin'), field: 'lastLoginAt', sortable: true, responsive: 'md' },
  { key: 'verified', label: t('users.columns.verified'), field: 'emailVerified', responsive: 'lg' },
  { key: 'mfa', label: t('users.columns.mfa'), field: 'twoFactorEnabled', responsive: 'lg' },
  { key: 'createdAt', label: t('users.columns.createdAt'), field: 'createdAt', sortable: true, responsive: 'lg' },
  { key: 'actions', label: t('users.columns.actions'), align: 'right' },
]);

const menuPos = ref({ top: 0, left: 0 });
const MENU_WIDTH = 176; // w-44

function toggleMenu(user: User, event: MouseEvent) {
  if (actionMenuUser.value === user.id) {
    actionMenuUser.value = null;
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  menuPos.value = {
    top: rect.bottom + 4,
    left: Math.max(8, rect.right - MENU_WIDTH),
  };
  actionMenuUser.value = user.id;
}

function onMenuScroll() {
  if (actionMenuUser.value) actionMenuUser.value = null;
}

onMounted(() => {
  window.addEventListener('scroll', onMenuScroll, true);
  window.addEventListener('resize', onMenuScroll);
});
onUnmounted(() => {
  window.removeEventListener('scroll', onMenuScroll, true);
  window.removeEventListener('resize', onMenuScroll);
});

const createModalTags = computed(() => {
  const tags: Array<{ label: string; variant: 'error' | 'warning' | 'neutral' }> = [];
  const role = createForm.value.role;
  tags.push({ label: role === 'admin' ? t('users.admin') : t('users.user'), variant: role === 'admin' ? 'warning' : 'neutral' });
  return tags;
});

const editModalTags = computed(() => {
  const tags: Array<{ label: string; variant: 'error' | 'warning' | 'neutral' }> = [];
  const role = editForm.value.role;
  tags.push({ label: role === 'admin' ? t('users.admin') : t('users.user'), variant: role === 'admin' ? 'warning' : 'neutral' });
  return tags;
});
</script>

<template>
  <AppLayout :title="t('users.title')" :subtitle="t('users.subtitle')">
    <div class="space-y-5">
      <div class="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div class="flex flex-col sm:flex-row gap-3 flex-1 w-full">
          <div class="relative flex-1 max-w-xs">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" />
            <input
              v-model="search"
              :placeholder="t('users.searchPlaceholder')"
              class="w-full pl-9 pr-3 py-2 text-sm bg-surface-800 border border-surface-600 rounded-lg text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500"
            />
          </div>
          <BaseSelect v-model="filterRole" :options="roleOptions" class="w-40" />
          <BaseSelect v-model="filterStatus" :options="statusOptions" class="w-40" />
        </div>
        <BaseButton @click="showCreateModal = true">
          <UserPlus class="w-4 h-4" />
          {{ t('users.createUser') }}
        </BaseButton>
      </div>

      <DataTable
        :columns="userColumns"
        :items="filteredUsers"
        :loading="store.loading"
        :empty="!store.loading && filteredUsers.length === 0"
        :row-key="(u: User) => u.id"
        enable-column-visibility
        enable-density-toggle
        clickable-rows
        @row-click="(u: User) => router.push(`/users/${u.id}`)"
      >
        <template #empty>
          <EmptyState :title="t('users.noUsers')" :message="t('users.noUsersMessage')">
            <template #action>
              <BaseButton @click="showCreateModal = true" size="sm">
                <UserPlus class="w-3.5 h-3.5" />
                {{ t('users.createUser') }}
              </BaseButton>
            </template>
          </EmptyState>
        </template>

        <template #cell-name="{ row }">
          <div class="flex items-center gap-3">
            <UserAvatar :name="(row as User).name" :image="(row as User).image" size="sm" />
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium text-surface-200 truncate">{{ (row as User).name }}</p>
                <BaseBadge v-if="(row as User).banned" variant="error" size="sm">{{ t('users.banned') }}</BaseBadge>
              </div>
              <p class="text-xs text-surface-500 truncate">{{ (row as User).email }}</p>
            </div>
          </div>
        </template>

        <template #cell-role="{ row }">
          <BaseBadge :variant="roleBadgeVariant((row as User).role)">
            <ShieldAlert v-if="(row as User).role === 'superadmin'" class="w-3 h-3" />
            <Shield v-else-if="(row as User).role === 'admin'" class="w-3 h-3" />
            <UserIcon v-else class="w-3 h-3" />
            {{ (row as User).role ? t(`users.${(row as User).role}`) : t('users.user') }}
          </BaseBadge>
        </template>

        <template #cell-applications="{ row }">
          <AppIconStack :apps="(row as User).applications ?? []" />
        </template>

        <template #cell-lastLogin="{ row }">
          <span class="text-xs text-surface-500">{{ formatLastLogin((row as User).lastLoginAt) }}</span>
        </template>

        <template #cell-verified="{ row }">
          <CheckCircle v-if="(row as User).emailVerified" class="w-4 h-4 text-emerald-400" />
          <XCircle v-else class="w-4 h-4 text-surface-600" />
        </template>

        <template #cell-mfa="{ row }">
          <CheckCircle v-if="(row as User).twoFactorEnabled" class="w-4 h-4 text-emerald-400" />
          <XCircle v-else class="w-4 h-4 text-surface-600" />
        </template>

        <template #cell-createdAt="{ row }">
          <span class="text-xs text-surface-500">{{ formatDate((row as User).createdAt) }}</span>
        </template>

        <template #cell-actions="{ row }">
          <div class="flex items-center justify-end gap-1">
            <div class="relative">
              <button
                @click.stop="toggleMenu(row as User, $event)"
                class="p-1.5 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-surface-700/50 transition-colors"
              >
                <MoreHorizontal class="w-4 h-4" />
              </button>
              <Teleport to="body">
                <div
                  v-if="actionMenuUser === (row as User).id"
                  :style="{ position: 'fixed', top: `${menuPos.top}px`, left: `${menuPos.left}px` }"
                  class="w-44 bg-surface-800 border border-surface-700/50 rounded-xl shadow-xl z-[100] overflow-hidden animate-slide-up"
                  v-click-outside="() => actionMenuUser = null"
                >
                  <button @click="router.push(`/users/${(row as User).id}`); actionMenuUser = null;" class="w-full text-left px-3 py-2.5 text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-700/50 flex items-center gap-2"><Eye class="w-4 h-4" />{{ t('common.view') }}</button>
                  <button @click="openEdit(row as User)" class="w-full text-left px-3 py-2.5 text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-700/50 flex items-center gap-2"><Pencil class="w-4 h-4" />{{ t('users.editUser') }}</button>
                  <button v-if="(row as User).banned" @click="handleUnban(row as User)" class="w-full text-left px-3 py-2.5 text-sm text-emerald-400 hover:bg-surface-700/50 flex items-center gap-2"><CheckCircle2 class="w-4 h-4" />{{ t('users.enable') }}</button>
                  <button v-else @click="openDisable(row as User)" class="w-full text-left px-3 py-2.5 text-sm text-amber-400 hover:bg-surface-700/50 flex items-center gap-2"><Ban class="w-4 h-4" />{{ t('users.disable') }}</button>
                  <button @click="openDelete(row as User)" class="w-full text-left px-3 py-2.5 text-sm text-red-400 hover:bg-surface-700/50 flex items-center gap-2"><Trash2 class="w-4 h-4" />{{ t('users.deleteUser') }}</button>
                </div>
              </Teleport>
            </div>
          </div>
        </template>
      </DataTable>

      <div v-if="store.total > 20" class="flex items-center justify-between text-sm text-surface-500">
        <span>{{ store.total }} {{ t('users.title').toLowerCase() }}</span>
        <div class="flex gap-2">
          <BaseButton variant="outline" size="sm" :disabled="page === 1" @click="page--; loadUsers()">{{ t('common.previous') }}</BaseButton>
          <BaseButton variant="outline" size="sm" :disabled="page * 20 >= store.total" @click="page++; loadUsers()">{{ t('common.next') }}</BaseButton>
        </div>
      </div>
    </div>

    <EntityModal
      :open="showCreateModal"
      :name="createForm.name || t('users.createUser')"
      :subtitle="createForm.email || 'user@example.com'"
      icon-shape="circle"
      :icon-letter="createForm.name ? createForm.name[0].toUpperCase() : 'U'"
      :tags="createModalTags"
      size="md"
      @close="showCreateModal = false"
    >
      <form @submit.prevent="handleCreate" class="space-y-4">
        <BaseInput v-model="createForm.name" :label="t('users.name')" required />
        <BaseInput v-model="createForm.email" :label="t('users.email')" type="email" required />
        <BaseInput v-model="createForm.password" :label="t('users.password')" type="password" required />
        <BaseSelect
          v-model="createForm.role"
          :label="t('users.role')"
          :options="assignableRoleOptions"
        />
        <p v-if="formError" class="text-sm text-red-400">{{ formError }}</p>
      </form>
      <template #footer>
        <BaseButton variant="ghost" @click="showCreateModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleCreate">{{ t('common.create') }}</BaseButton>
      </template>
    </EntityModal>

    <EntityModal
      :open="showEditModal"
      :name="editForm.name || selectedUser?.name || t('users.editUser')"
      :subtitle="selectedUser?.email ?? ''"
      icon-shape="circle"
      :icon-letter="(editForm.name || selectedUser?.name || 'U')[0].toUpperCase()"
      :icon-url="selectedUser?.image ?? null"
      :tags="editModalTags"
      size="md"
      @close="showEditModal = false"
    >
      <form @submit.prevent="handleEdit" class="space-y-4">
        <BaseInput v-model="editForm.name" :label="t('users.name')" required />
        <BaseSelect
          v-model="editForm.role"
          :label="t('users.role')"
          :options="assignableRoleOptions"
          :disabled="selectedUser?.role === 'superadmin'"
        />
        <p v-if="formError" class="text-sm text-red-400">{{ formError }}</p>
      </form>
      <template #footer>
        <BaseButton variant="ghost" @click="showEditModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleEdit">{{ t('common.save') }}</BaseButton>
      </template>
    </EntityModal>

    <ConfirmDialog
      :open="showDeleteConfirm"
      :title="t('users.deleteUser')"
      :message="deleteError || t('users.confirmDelete')"
      :confirm-label="t('common.delete')"
      :loading="deleteLoading"
      @confirm="handleDelete"
      @cancel="showDeleteConfirm = false"
    />

    <ConfirmDialog
      :open="showDisableConfirm"
      :title="t('users.disable')"
      :message="t('users.confirmDisable')"
      :confirm-label="t('users.disable')"
      :loading="actionLoading"
      @confirm="handleDisable"
      @cancel="showDisableConfirm = false"
    />
  </AppLayout>
</template>
