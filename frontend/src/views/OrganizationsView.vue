<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOrganizationsStore } from '@/stores/organizations';
import { createOrganization, updateOrganization, addMember, removeMember, sendInvitation, cancelInvitation } from '@/api/organizations';
import { listUsers } from '@/api/users';
import { useToast } from '@/composables/useToast';
import type { Organization } from '@/types';
import AppLayout from '@/components/layout/AppLayout.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import SearchSelect from '@/components/ui/SearchSelect.vue';
import EntityModal from '@/components/ui/EntityModal.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { Building2, Plus, Search, ChevronDown, ChevronUp, Users, Mail, X, ChevronLeft, ChevronRight } from 'lucide-vue-next';

const { t } = useI18n();
const store = useOrganizationsStore();
const toast = useToast();

const searchInput = ref('');
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

const expandedOrg = ref<string | null>(null);

const showCreateModal = ref(false);
const showEditModal = ref(false);
const showDeleteConfirm = ref(false);
const showAddMember = ref(false);
const showInviteModal = ref(false);
const formLoading = ref(false);
const deleteLoading = ref(false);
const selectedOrg = ref<Organization | null>(null);

const createForm = ref({ name: '', slug: '', logo: '', metadata: '' });
const editForm = ref({ name: '', slug: '', logo: '', metadata: '' });
const addMemberForm = ref({ userId: '', role: 'member' as 'owner' | 'admin' | 'member' });
const inviteForm = ref({ email: '', role: 'member' as 'owner' | 'admin' | 'member' });

onMounted(() => store.fetchOrganizations());

// Server-side search with debounce
watch(searchInput, (val) => {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    store.fetchOrganizations({ search: val, page: 1 });
  }, 350);
});

const totalPages = computed(() => Math.ceil(store.total / store.limit) || 1);

function goToPage(p: number) {
  if (p < 1 || p > totalPages.value) return;
  store.fetchOrganizations({ page: p });
}

function slugify(name: string) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

watch(() => createForm.value.name, (name) => {
  createForm.value.slug = slugify(name);
});

// Lazy-load members when expanding an org row
watch(expandedOrg, (orgId) => {
  if (orgId && !store.orgMembers[orgId]) {
    store.fetchOrgMembers(orgId);
  }
});

async function handleCreate() {
  formLoading.value = true;
  try {
    await createOrganization({ name: createForm.value.name, slug: createForm.value.slug, logo: createForm.value.logo || undefined, metadata: createForm.value.metadata || undefined });
    await store.fetchOrganizations({ page: 1 });
    toast.success('Organization created');
    showCreateModal.value = false;
    createForm.value = { name: '', slug: '', logo: '', metadata: '' };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to create');
  } finally {
    formLoading.value = false;
  }
}

async function handleEdit() {
  if (!selectedOrg.value) return;
  formLoading.value = true;
  try {
    await updateOrganization(selectedOrg.value.id, { name: editForm.value.name, slug: editForm.value.slug, logo: editForm.value.logo || undefined, metadata: editForm.value.metadata || undefined });
    await store.fetchOrganizations();
    toast.success('Organization updated');
    showEditModal.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to update');
  } finally {
    formLoading.value = false;
  }
}

async function handleDelete() {
  if (!selectedOrg.value) return;
  deleteLoading.value = true;
  try {
    await store.deleteOrganization(selectedOrg.value.id);
    if (expandedOrg.value === selectedOrg.value.id) expandedOrg.value = null;
    toast.success('Organization deleted');
    showDeleteConfirm.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to delete');
  } finally {
    deleteLoading.value = false;
  }
}

async function handleAddMember() {
  if (!selectedOrg.value || !addMemberForm.value.userId) return;
  formLoading.value = true;
  try {
    await addMember(selectedOrg.value.id, { userId: addMemberForm.value.userId, role: addMemberForm.value.role });
    // Refresh only that org's members (not the whole list)
    await store.fetchOrgMembers(selectedOrg.value.id);
    toast.success('Member added');
    showAddMember.value = false;
    addMemberForm.value = { userId: '', role: 'member' };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to add member');
  } finally {
    formLoading.value = false;
  }
}

async function handleRemoveMember(orgId: string, userId: string) {
  try {
    await removeMember(orgId, userId);
    // Refresh only that org's members
    await store.fetchOrgMembers(orgId);
    toast.success('Member removed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to remove member');
  }
}

async function handleInvite() {
  if (!selectedOrg.value || !inviteForm.value.email) return;
  formLoading.value = true;
  try {
    await sendInvitation(selectedOrg.value.id, { email: inviteForm.value.email, role: inviteForm.value.role });
    toast.success('Invitation sent');
    showInviteModal.value = false;
    inviteForm.value = { email: '', role: 'member' };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to send invitation');
  } finally {
    formLoading.value = false;
  }
}

function openEdit(org: Organization) {
  selectedOrg.value = org;
  editForm.value = { name: org.name, slug: org.slug, logo: org.logo ?? '', metadata: org.metadata ?? '' };
  showEditModal.value = true;
}

/** SearchSelect loader for users */
async function loadUserOptions(search: string) {
  const res = await listUsers({ search, limit: 10 });
  return res.users.map(u => ({ value: u.id, label: u.name, sublabel: u.email }));
}

const roleOptions = [
  { value: 'owner', label: t('organizations.owner') },
  { value: 'admin', label: t('users.admin') },
  { value: 'member', label: 'Member' },
];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

const createModalTags = computed(() => {
  const tags: Array<{ label: string; variant: 'info' | 'neutral' }> = [];
  if (createForm.value.slug) tags.push({ label: createForm.value.slug, variant: 'info' });
  return tags;
});

void cancelInvitation;
</script>

<template>
  <AppLayout :title="t('organizations.title')" :subtitle="t('organizations.subtitle')">
    <div class="space-y-5">
      <div class="flex items-center justify-between gap-3">
        <div class="relative flex-1 max-w-xs">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" />
          <input
            v-model="searchInput"
            :placeholder="t('organizations.searchPlaceholder')"
            class="w-full pl-9 pr-3 py-2 text-sm bg-surface-800 border border-surface-600 rounded-lg text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50"
          />
        </div>
        <BaseButton @click="showCreateModal = true">
          <Plus class="w-4 h-4" />
          {{ t('organizations.createOrg') }}
        </BaseButton>
      </div>

      <div v-if="store.loading" class="space-y-3">
        <div v-for="i in 3" :key="i" class="h-24 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-2xl" />
      </div>

      <EmptyState v-else-if="store.organizations.length === 0" :title="t('organizations.noOrgs')" :message="t('organizations.noOrgsMessage')">
        <template #action>
          <BaseButton @click="showCreateModal = true" size="sm"><Plus class="w-3.5 h-3.5" />{{ t('organizations.createOrg') }}</BaseButton>
        </template>
      </EmptyState>

      <div v-else class="space-y-3">
        <div
          v-for="org in store.organizations"
          :key="org.id"
          class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden transition-all duration-200"
        >
          <div class="px-5 py-4 flex items-center gap-4 cursor-pointer hover:bg-surface-800/20 transition-colors" @click="expandedOrg = expandedOrg === org.id ? null : org.id">
            <div class="w-10 h-10 rounded-xl overflow-hidden shrink-0">
              <img v-if="org.logo" :src="org.logo" class="w-full h-full object-cover" />
              <div v-else class="w-full h-full bg-primary-600/20 flex items-center justify-center">
                <Building2 class="w-5 h-5 text-primary-400" />
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-semibold text-surface-200">{{ org.name }}</p>
              <p class="text-xs text-surface-500 font-mono">{{ org.slug }}</p>
            </div>
            <div class="flex items-center gap-4 shrink-0">
              <div class="flex items-center gap-1.5 text-xs text-surface-500">
                <Users class="w-3.5 h-3.5" />
                {{ org.memberCount ?? store.orgMembers[org.id]?.length ?? 0 }}
              </div>
              <span class="text-xs text-surface-600 hidden sm:block">{{ formatDate(org.createdAt) }}</span>
              <div class="flex items-center gap-1">
                <button @click.stop="openEdit(org)" class="p-1.5 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-surface-700/50 transition-colors text-xs">{{ t('common.edit') }}</button>
                <button @click.stop="selectedOrg = org; showDeleteConfirm = true" class="p-1.5 rounded-lg text-red-500 hover:text-red-400 hover:bg-red-500/10 transition-colors text-xs">{{ t('common.delete') }}</button>
              </div>
              <component :is="expandedOrg === org.id ? ChevronUp : ChevronDown" class="w-4 h-4 text-surface-500" />
            </div>
          </div>

          <div v-if="expandedOrg === org.id" class="border-t border-surface-700/30 px-5 py-4 space-y-5 animate-fade-in">
            <div>
              <div class="flex items-center justify-between mb-3">
                <h4 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">Members</h4>
                <div class="flex gap-2">
                  <BaseButton variant="outline" size="sm" @click="selectedOrg = org; showInviteModal = true">
                    <Mail class="w-3.5 h-3.5" /> Invite
                  </BaseButton>
                  <BaseButton variant="secondary" size="sm" @click="selectedOrg = org; showAddMember = true">
                    <Plus class="w-3.5 h-3.5" /> Add
                  </BaseButton>
                </div>
              </div>
              <div v-if="store.membersLoading[org.id]" class="space-y-2">
                <div v-for="i in 2" :key="i" class="h-10 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-xl" />
              </div>
              <div v-else-if="!store.orgMembers[org.id]?.length" class="text-xs text-surface-500 py-2">{{ t('organizations.noMembers') }}</div>
              <div v-else class="space-y-2">
                <div v-for="member in store.orgMembers[org.id]" :key="member.id" class="flex items-center gap-3 py-2 px-3 rounded-xl hover:bg-surface-800/40 transition-colors group">
                  <UserAvatar :name="member.user?.name ?? member.userId" :image="member.user?.image ?? null" size="xs" />
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-surface-200">{{ member.user?.name ?? member.userId }}</p>
                    <p class="text-xs text-surface-500">{{ member.user?.email ?? '' }}</p>
                  </div>
                  <BaseBadge :variant="member.role === 'owner' ? 'warning' : 'neutral'" size="sm">{{ member.role }}</BaseBadge>
                  <button @click="handleRemoveMember(org.id, member.userId)" class="opacity-0 group-hover:opacity-100 p-1 rounded text-red-500 hover:bg-red-500/10 transition-all">
                    <X class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div v-if="store.total > store.limit" class="flex items-center justify-between pt-2">
        <p class="text-xs text-surface-500">
          {{ t('common.showing', { from: (store.page - 1) * store.limit + 1, to: Math.min(store.page * store.limit, store.total), total: store.total }) }}
        </p>
        <div class="flex items-center gap-1">
          <button
            :disabled="store.page <= 1"
            @click="goToPage(store.page - 1)"
            class="p-1.5 rounded-lg text-surface-400 hover:text-surface-200 hover:bg-surface-700/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft class="w-4 h-4" />
          </button>
          <template v-for="p in totalPages" :key="p">
            <button
              v-if="p === 1 || p === totalPages || Math.abs(p - store.page) <= 1"
              @click="goToPage(p)"
              :class="[
                'min-w-[2rem] h-8 rounded-lg text-xs font-medium transition-colors',
                store.page === p ? 'bg-primary-600 text-white' : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700/50',
              ]"
            >{{ p }}</button>
            <span v-else-if="p === 2 && store.page > 3" class="text-surface-600 text-xs px-1">…</span>
            <span v-else-if="p === totalPages - 1 && store.page < totalPages - 2" class="text-surface-600 text-xs px-1">…</span>
          </template>
          <button
            :disabled="store.page >= totalPages"
            @click="goToPage(store.page + 1)"
            class="p-1.5 rounded-lg text-surface-400 hover:text-surface-200 hover:bg-surface-700/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>

    <EntityModal
      :open="showCreateModal"
      :name="createForm.name || t('organizations.createOrg')"
      :subtitle="createForm.slug || 'org-slug'"
      :icon-url="createForm.logo || null"
      :icon-letter="createForm.name ? createForm.name[0].toUpperCase() : 'O'"
      icon-shape="square"
      :tags="createModalTags"
      size="lg"
      @close="showCreateModal = false"
    >
      <form @submit.prevent="handleCreate" class="space-y-4">
        <BaseInput v-model="createForm.name" :label="t('organizations.name')" required />
        <BaseInput v-model="createForm.slug" :label="t('organizations.slug')" required />
        <BaseInput v-model="createForm.logo" :label="t('organizations.logo')" />
        <BaseInput v-model="createForm.metadata" :label="t('organizations.metadata')" />
      </form>
      <template #footer>
        <BaseButton variant="ghost" @click="showCreateModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleCreate">{{ t('common.create') }}</BaseButton>
      </template>
    </EntityModal>

    <EntityModal
      :open="showEditModal"
      :name="editForm.name || selectedOrg?.name || t('organizations.editOrg')"
      :subtitle="editForm.slug || selectedOrg?.slug || ''"
      :icon-url="(editForm.logo || selectedOrg?.logo) ?? null"
      :icon-letter="(editForm.name || selectedOrg?.name || 'O')[0].toUpperCase()"
      icon-shape="square"
      size="lg"
      @close="showEditModal = false"
    >
      <form @submit.prevent="handleEdit" class="space-y-4">
        <BaseInput v-model="editForm.name" :label="t('organizations.name')" required />
        <BaseInput v-model="editForm.slug" :label="t('organizations.slug')" required />
        <BaseInput v-model="editForm.logo" :label="t('organizations.logo')" />
      </form>
      <template #footer>
        <BaseButton variant="ghost" @click="showEditModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleEdit">{{ t('common.save') }}</BaseButton>
      </template>
    </EntityModal>

    <BaseModal :open="showAddMember" title="Add Member" @close="showAddMember = false">
      <div class="space-y-4">
        <SearchSelect
          v-model="addMemberForm.userId"
          label="User"
          placeholder="Search users…"
          :load-options="loadUserOptions"
          required
        />
        <BaseSelect v-model="addMemberForm.role" label="Role" :options="roleOptions" />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showAddMember = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleAddMember">{{ t('organizations.addMember') }}</BaseButton>
      </template>
    </BaseModal>

    <BaseModal :open="showInviteModal" :title="t('organizations.sendInvitation')" @close="showInviteModal = false">
      <div class="space-y-4">
        <BaseInput v-model="inviteForm.email" :label="t('organizations.inviteEmail')" type="email" required />
        <BaseSelect v-model="inviteForm.role" :label="t('organizations.inviteRole')" :options="roleOptions" />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showInviteModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleInvite">{{ t('organizations.sendInvitation') }}</BaseButton>
      </template>
    </BaseModal>

    <ConfirmDialog
      :open="showDeleteConfirm"
      :title="t('organizations.deleteOrg')"
      :message="t('organizations.confirmDelete')"
      :confirm-label="t('common.delete')"
      :loading="deleteLoading"
      @confirm="handleDelete"
      @cancel="showDeleteConfirm = false"
    />
  </AppLayout>
</template>

import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import EntityModal from '@/components/ui/EntityModal.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import UserAvatar from '@/components/ui/UserAvatar.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { Building2, Plus, Search, ChevronDown, ChevronUp, Users, Mail, X } from 'lucide-vue-next';

const { t } = useI18n();
const store = useOrganizationsStore();
const toast = useToast();

const search = ref('');
const expandedOrg = ref<string | null>(null);
const allUsers = ref<User[]>([]);

const showCreateModal = ref(false);
const showEditModal = ref(false);
const showDeleteConfirm = ref(false);
const showAddMember = ref(false);
const showInviteModal = ref(false);
const formLoading = ref(false);
const deleteLoading = ref(false);
const selectedOrg = ref<Organization | null>(null);

const createForm = ref({ name: '', slug: '', logo: '', metadata: '' });
const editForm = ref({ name: '', slug: '', logo: '', metadata: '' });
const addMemberForm = ref({ userId: '', role: 'member' as 'owner' | 'admin' | 'member' });
const inviteForm = ref({ email: '', role: 'member' as 'owner' | 'admin' | 'member' });

onMounted(async () => {
  await store.fetchOrganizations();
  const res = await listUsers({ limit: 100 });
  allUsers.value = res.users;
});

const filtered = computed(() =>
  store.organizations.filter(o => !search.value || o.name.toLowerCase().includes(search.value.toLowerCase()))
);

function slugify(name: string) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

watch(() => createForm.value.name, (name) => {
  createForm.value.slug = slugify(name);
});

async function handleCreate() {
  formLoading.value = true;
  try {
    await createOrganization({ name: createForm.value.name, slug: createForm.value.slug, logo: createForm.value.logo || undefined, metadata: createForm.value.metadata || undefined });
    await store.fetchOrganizations();
    toast.success('Organization created');
    showCreateModal.value = false;
    createForm.value = { name: '', slug: '', logo: '', metadata: '' };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to create');
  } finally {
    formLoading.value = false;
  }
}

async function handleEdit() {
  if (!selectedOrg.value) return;
  formLoading.value = true;
  try {
    await updateOrganization(selectedOrg.value.id, { name: editForm.value.name, slug: editForm.value.slug, logo: editForm.value.logo || undefined, metadata: editForm.value.metadata || undefined });
    await store.fetchOrganizations();
    toast.success('Organization updated');
    showEditModal.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to update');
  } finally {
    formLoading.value = false;
  }
}

async function handleDelete() {
  if (!selectedOrg.value) return;
  deleteLoading.value = true;
  try {
    await store.deleteOrganization(selectedOrg.value.id);
    toast.success('Organization deleted');
    showDeleteConfirm.value = false;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to delete');
  } finally {
    deleteLoading.value = false;
  }
}

async function handleAddMember() {
  if (!selectedOrg.value || !addMemberForm.value.userId) return;
  formLoading.value = true;
  try {
    await addMember(selectedOrg.value.id, { userId: addMemberForm.value.userId, role: addMemberForm.value.role });
    await store.fetchOrganizations();
    toast.success('Member added');
    showAddMember.value = false;
    addMemberForm.value = { userId: '', role: 'member' };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to add member');
  } finally {
    formLoading.value = false;
  }
}

async function handleRemoveMember(orgId: string, userId: string) {
  try {
    await removeMember(orgId, userId);
    await store.fetchOrganizations();
    toast.success('Member removed');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to remove member');
  }
}

async function handleInvite() {
  if (!selectedOrg.value || !inviteForm.value.email) return;
  formLoading.value = true;
  try {
    await sendInvitation(selectedOrg.value.id, { email: inviteForm.value.email, role: inviteForm.value.role });
    toast.success('Invitation sent');
    showInviteModal.value = false;
    inviteForm.value = { email: '', role: 'member' };
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to send invitation');
  } finally {
    formLoading.value = false;
  }
}

function openEdit(org: Organization) {
  selectedOrg.value = org;
  editForm.value = { name: org.name, slug: org.slug, logo: org.logo ?? '', metadata: org.metadata ?? '' };
  showEditModal.value = true;
}

function getUserName(userId: string) {
  return allUsers.value.find(u => u.id === userId)?.name ?? userId;
}

function getUserEmail(userId: string) {
  return allUsers.value.find(u => u.id === userId)?.email ?? '';
}

function getUserImage(userId: string) {
  return allUsers.value.find(u => u.id === userId)?.image ?? null;
}

const roleOptions = [
  { value: 'owner', label: t('organizations.owner') },
  { value: 'admin', label: t('users.admin') },
  { value: 'member', label: 'Member' },
];

const userOptions = computed(() => allUsers.value.map(u => ({ value: u.id, label: `${u.name} (${u.email})` })));

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

const createModalTags = computed(() => {
  const tags: Array<{ label: string; variant: 'info' | 'neutral' }> = [];
  if (createForm.value.slug) tags.push({ label: createForm.value.slug, variant: 'info' });
  return tags;
});

void cancelInvitation;
</script>

<template>
  <AppLayout :title="t('organizations.title')" :subtitle="t('organizations.subtitle')">
    <div class="space-y-5">
      <div class="flex items-center justify-between gap-3">
        <div class="relative flex-1 max-w-xs">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" />
          <input
            v-model="search"
            :placeholder="t('organizations.searchPlaceholder')"
            class="w-full pl-9 pr-3 py-2 text-sm bg-surface-800 border border-surface-600 rounded-lg text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50"
          />
        </div>
        <BaseButton @click="showCreateModal = true">
          <Plus class="w-4 h-4" />
          {{ t('organizations.createOrg') }}
        </BaseButton>
      </div>

      <div v-if="store.loading" class="space-y-3">
        <div v-for="i in 3" :key="i" class="h-24 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-2xl" />
      </div>

      <EmptyState v-else-if="filtered.length === 0" :title="t('organizations.noOrgs')" :message="t('organizations.noOrgsMessage')">
        <template #action>
          <BaseButton @click="showCreateModal = true" size="sm"><Plus class="w-3.5 h-3.5" />{{ t('organizations.createOrg') }}</BaseButton>
        </template>
      </EmptyState>

      <div v-else class="space-y-3">
        <div
          v-for="org in filtered"
          :key="org.id"
          class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden transition-all duration-200"
        >
          <div class="px-5 py-4 flex items-center gap-4 cursor-pointer hover:bg-surface-800/20 transition-colors" @click="expandedOrg = expandedOrg === org.id ? null : org.id">
            <div class="w-10 h-10 rounded-xl overflow-hidden shrink-0">
              <img v-if="org.logo" :src="org.logo" class="w-full h-full object-cover" />
              <div v-else class="w-full h-full bg-primary-600/20 flex items-center justify-center">
                <Building2 class="w-5 h-5 text-primary-400" />
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-semibold text-surface-200">{{ org.name }}</p>
              <p class="text-xs text-surface-500 font-mono">{{ org.slug }}</p>
            </div>
            <div class="flex items-center gap-4 shrink-0">
              <div class="flex items-center gap-1.5 text-xs text-surface-500">
                <Users class="w-3.5 h-3.5" />
                {{ org.members?.length ?? 0 }}
              </div>
              <span class="text-xs text-surface-600 hidden sm:block">{{ formatDate(org.createdAt) }}</span>
              <div class="flex items-center gap-1">
                <button @click.stop="openEdit(org)" class="p-1.5 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-surface-700/50 transition-colors text-xs">{{ t('common.edit') }}</button>
                <button @click.stop="selectedOrg = org; showDeleteConfirm = true" class="p-1.5 rounded-lg text-red-500 hover:text-red-400 hover:bg-red-500/10 transition-colors text-xs">{{ t('common.delete') }}</button>
              </div>
              <component :is="expandedOrg === org.id ? ChevronUp : ChevronDown" class="w-4 h-4 text-surface-500" />
            </div>
          </div>

          <div v-if="expandedOrg === org.id" class="border-t border-surface-700/30 px-5 py-4 space-y-5 animate-fade-in">
            <div>
              <div class="flex items-center justify-between mb-3">
                <h4 class="text-xs font-semibold text-surface-400 uppercase tracking-wide">Members</h4>
                <div class="flex gap-2">
                  <BaseButton variant="outline" size="sm" @click="selectedOrg = org; showInviteModal = true">
                    <Mail class="w-3.5 h-3.5" /> Invite
                  </BaseButton>
                  <BaseButton variant="secondary" size="sm" @click="selectedOrg = org; showAddMember = true">
                    <Plus class="w-3.5 h-3.5" /> Add
                  </BaseButton>
                </div>
              </div>
              <div v-if="!org.members?.length" class="text-xs text-surface-500 py-2">{{ t('organizations.noMembers') }}</div>
              <div v-else class="space-y-2">
                <div v-for="member in org.members" :key="member.id" class="flex items-center gap-3 py-2 px-3 rounded-xl hover:bg-surface-800/40 transition-colors group">
                  <UserAvatar :name="getUserName(member.userId)" :image="getUserImage(member.userId)" size="xs" />
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-surface-200">{{ getUserName(member.userId) }}</p>
                    <p class="text-xs text-surface-500">{{ getUserEmail(member.userId) }}</p>
                  </div>
                  <BaseBadge :variant="member.role === 'owner' ? 'warning' : 'neutral'" size="sm">{{ member.role }}</BaseBadge>
                  <button @click="handleRemoveMember(org.id, member.userId)" class="opacity-0 group-hover:opacity-100 p-1 rounded text-red-500 hover:bg-red-500/10 transition-all">
                    <X class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <EntityModal
      :open="showCreateModal"
      :name="createForm.name || t('organizations.createOrg')"
      :subtitle="createForm.slug || 'org-slug'"
      :icon-url="createForm.logo || null"
      :icon-letter="createForm.name ? createForm.name[0].toUpperCase() : 'O'"
      icon-shape="square"
      :tags="createModalTags"
      size="lg"
      @close="showCreateModal = false"
    >
      <form @submit.prevent="handleCreate" class="space-y-4">
        <BaseInput v-model="createForm.name" :label="t('organizations.name')" required />
        <BaseInput v-model="createForm.slug" :label="t('organizations.slug')" required />
        <BaseInput v-model="createForm.logo" :label="t('organizations.logo')" />
        <BaseInput v-model="createForm.metadata" :label="t('organizations.metadata')" />
      </form>
      <template #footer>
        <BaseButton variant="ghost" @click="showCreateModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleCreate">{{ t('common.create') }}</BaseButton>
      </template>
    </EntityModal>

    <EntityModal
      :open="showEditModal"
      :name="editForm.name || selectedOrg?.name || t('organizations.editOrg')"
      :subtitle="editForm.slug || selectedOrg?.slug || ''"
      :icon-url="(editForm.logo || selectedOrg?.logo) ?? null"
      :icon-letter="(editForm.name || selectedOrg?.name || 'O')[0].toUpperCase()"
      icon-shape="square"
      size="lg"
      @close="showEditModal = false"
    >
      <form @submit.prevent="handleEdit" class="space-y-4">
        <BaseInput v-model="editForm.name" :label="t('organizations.name')" required />
        <BaseInput v-model="editForm.slug" :label="t('organizations.slug')" required />
        <BaseInput v-model="editForm.logo" :label="t('organizations.logo')" />
      </form>
      <template #footer>
        <BaseButton variant="ghost" @click="showEditModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleEdit">{{ t('common.save') }}</BaseButton>
      </template>
    </EntityModal>

    <BaseModal :open="showAddMember" title="Add Member" @close="showAddMember = false">
      <div class="space-y-4">
        <BaseSelect v-model="addMemberForm.userId" label="User" :options="userOptions" placeholder="Select a user" />
        <BaseSelect v-model="addMemberForm.role" label="Role" :options="roleOptions" />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showAddMember = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleAddMember">{{ t('organizations.addMember') }}</BaseButton>
      </template>
    </BaseModal>

    <BaseModal :open="showInviteModal" :title="t('organizations.sendInvitation')" @close="showInviteModal = false">
      <div class="space-y-4">
        <BaseInput v-model="inviteForm.email" :label="t('organizations.inviteEmail')" type="email" required />
        <BaseSelect v-model="inviteForm.role" :label="t('organizations.inviteRole')" :options="roleOptions" />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showInviteModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="formLoading" @click="handleInvite">{{ t('organizations.sendInvitation') }}</BaseButton>
      </template>
    </BaseModal>

    <ConfirmDialog
      :open="showDeleteConfirm"
      :title="t('organizations.deleteOrg')"
      :message="t('organizations.confirmDelete')"
      :confirm-label="t('common.delete')"
      :loading="deleteLoading"
      @confirm="handleDelete"
      @cancel="showDeleteConfirm = false"
    />
  </AppLayout>
</template>
