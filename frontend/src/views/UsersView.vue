<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useUsersStore } from '@/stores/users';
import { createUser, updateUser } from '@/api/users';
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
import { UserPlus, Search, CheckCircle, XCircle, Shield, ShieldAlert, User as UserIcon, MoreHorizontal, Eye } from 'lucide-vue-next';

const { t } = useI18n();
const router = useRouter();
const store = useUsersStore();
const toast = useToast();

const search = ref('');
const debouncedSearch = useDebounce(search);
const filterRole = ref('');
const filterStatus = ref('');
const page = ref(1);

const showCreateModal = ref(false);
const showEditModal = ref(false);
const showDeleteConfirm = ref(false);
const deleteLoading = ref(false);
const actionLoading = ref(false);
const deleteError = ref('');
const selectedUser = ref<User | null>(null);
const actionMenuUser = ref<string | null>(null);

const createForm = ref({ name: '', email: '', password: '', role: 'user' as 'user' | 'admin' | 'superadmin' });
const editForm = ref({ name: '', role: 'user' as 'user' | 'admin' | 'superadmin', isMfaRequired: undefined as boolean | undefined });
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

function openEdit(user: User) {
  selectedUser.value = user;
  editForm.value = { name: user.name, role: (user.role ?? 'user') as 'user' | 'admin' | 'superadmin', isMfaRequired: user.isMfaRequired ?? undefined };
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
    createForm.value = { name: '', email: '', password: '', role: 'user' };
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
    await updateUser(user.id, { banned: false, banReason: null, banExpires: null });
    await store.updateUser(user.id, { banned: false });
    toast.success('User unbanned');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to unban user');
  } finally {
    actionLoading.value = false;
    actionMenuUser.value = null;
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

const createModalTags = computed(() => {
  const tags: Array<{ label: string; variant: 'error' | 'warning' | 'neutral' }> = [];
  const role = createForm.value.role;
  tags.push({ label: role === 'superadmin' ? t('users.superadmin') : role === 'admin' ? t('users.admin') : t('users.user'), variant: role === 'superadmin' ? 'error' : role === 'admin' ? 'warning' : 'neutral' });
  return tags;
});

const editModalTags = computed(() => {
  const tags: Array<{ label: string; variant: 'error' | 'warning' | 'neutral' }> = [];
  const role = editForm.value.role;
  tags.push({ label: role === 'superadmin' ? t('users.superadmin') : role === 'admin' ? t('users.admin') : t('users.user'), variant: role === 'superadmin' ? 'error' : role === 'admin' ? 'warning' : 'neutral' });
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

      <DataTable :loading="store.loading" :empty="!store.loading && filteredUsers.length === 0" :skeleton-cols="6">
        <template #head>
          <th class="px-4 py-3 text-left text-xs font-medium text-surface-500 uppercase tracking-wide">{{ t('users.name') }}</th>
          <th class="px-4 py-3 text-left text-xs font-medium text-surface-500 uppercase tracking-wide hidden md:table-cell">{{ t('users.role') }}</th>
          <th class="px-4 py-3 text-left text-xs font-medium text-surface-500 uppercase tracking-wide hidden lg:table-cell">{{ t('users.verified') }}</th>
          <th class="px-4 py-3 text-left text-xs font-medium text-surface-500 uppercase tracking-wide hidden lg:table-cell">{{ t('users.mfa') }}</th>
          <th class="px-4 py-3 text-left text-xs font-medium text-surface-500 uppercase tracking-wide hidden xl:table-cell">{{ t('users.createdAt') }}</th>
          <th class="px-4 py-3 text-right text-xs font-medium text-surface-500 uppercase tracking-wide">{{ t('common.actions') }}</th>
        </template>

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

        <tr
          v-for="user in filteredUsers"
          :key="user.id"
          class="border-b border-surface-800/40 last:border-0 hover:bg-surface-800/20 transition-colors"
        >
          <td class="px-4 py-3">
            <div class="flex items-center gap-3">
              <UserAvatar :name="user.name" :image="user.image" size="sm" />
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <p class="text-sm font-medium text-surface-200 truncate">{{ user.name }}</p>
                  <BaseBadge v-if="user.banned" variant="error" size="sm">{{ t('users.banned') }}</BaseBadge>
                </div>
                <p class="text-xs text-surface-500 truncate">{{ user.email }}</p>
              </div>
            </div>
          </td>
          <td class="px-4 py-3 hidden md:table-cell">
            <BaseBadge :variant="roleBadgeVariant(user.role)">
              <ShieldAlert v-if="user.role === 'superadmin'" class="w-3 h-3" />
              <Shield v-else-if="user.role === 'admin'" class="w-3 h-3" />
              <UserIcon v-else class="w-3 h-3" />
              {{ user.role ? t(`users.${user.role}`) : t('users.user') }}
            </BaseBadge>
          </td>
          <td class="px-4 py-3 hidden lg:table-cell">
            <CheckCircle v-if="user.emailVerified" class="w-4 h-4 text-emerald-400" />
            <XCircle v-else class="w-4 h-4 text-surface-600" />
          </td>
          <td class="px-4 py-3 hidden lg:table-cell">
            <CheckCircle v-if="user.twoFactorEnabled" class="w-4 h-4 text-emerald-400" />
            <XCircle v-else class="w-4 h-4 text-surface-600" />
          </td>
          <td class="px-4 py-3 hidden xl:table-cell">
            <span class="text-xs text-surface-500">{{ formatDate(user.createdAt) }}</span>
          </td>
          <td class="px-4 py-3 text-right">
            <div class="flex items-center justify-end gap-1">
              <button @click="router.push(`/users/${user.id}`)" class="p-1.5 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-surface-700/50 transition-colors">
                <Eye class="w-4 h-4" />
              </button>
              <div class="relative">
                <button
                  @click="actionMenuUser = actionMenuUser === user.id ? null : user.id"
                  class="p-1.5 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-surface-700/50 transition-colors"
                >
                  <MoreHorizontal class="w-4 h-4" />
                </button>
                <div
                  v-if="actionMenuUser === user.id"
                  class="absolute right-0 top-full mt-1 w-44 bg-surface-800 border border-surface-700/50 rounded-xl shadow-xl z-20 overflow-hidden animate-slide-up"
                  v-click-outside="() => actionMenuUser = null"
                >
                  <button @click="openEdit(user)" class="w-full text-left px-3 py-2.5 text-sm text-surface-300 hover:text-surface-100 hover:bg-surface-700/50">{{ t('users.editUser') }}</button>
                  <button v-if="user.banned" @click="handleUnban(user)" class="w-full text-left px-3 py-2.5 text-sm text-emerald-400 hover:bg-surface-700/50">{{ t('users.unban') }}</button>
                  <button @click="openDelete(user)" class="w-full text-left px-3 py-2.5 text-sm text-red-400 hover:bg-surface-700/50">{{ t('users.deleteUser') }}</button>
                </div>
              </div>
            </div>
          </td>
        </tr>
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
          :options="[{ value: 'user', label: t('users.user') }, { value: 'admin', label: t('users.admin') }, { value: 'superadmin', label: t('users.superadmin') }]"
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
          :options="[{ value: 'user', label: t('users.user') }, { value: 'admin', label: t('users.admin') }, { value: 'superadmin', label: t('users.superadmin') }]"
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
  </AppLayout>
</template>
