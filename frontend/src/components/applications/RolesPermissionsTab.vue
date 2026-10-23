<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Eye, Pencil, Plus, Trash2 } from 'lucide-vue-next';
import * as appsApi from '@/api/applications';
import { useToast } from '@/composables/useToast';
import BaseBadge from '@/components/ui/BaseBadge.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import BaseInput from '@/components/ui/BaseInput.vue';
import BaseModal from '@/components/ui/BaseModal.vue';
import BaseSelect from '@/components/ui/BaseSelect.vue';
import BaseToggle from '@/components/ui/BaseToggle.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import PermissionMatrix from './PermissionMatrix.vue';
import type { SelectOption } from '@/types/select';
import type { AppPermission, AppRole } from '@/types';

const props = defineProps<{ appId: string; appName: string }>();

const roles = defineModel<AppRole[]>('roles', { required: true });
const permissions = defineModel<AppPermission[]>('permissions', { required: true });

const { t } = useI18n();
const toast = useToast();

const saving = ref(false);
const pending = ref<Set<string>>(new Set());

// ── Role create / edit ─────────────────────────────────────────────────────────
const showRoleModal = ref(false);
const editingRole = ref<AppRole | null>(null);
const roleForm = ref({ name: '', description: '', isDefault: false });
const roleToDelete = ref<AppRole | null>(null);

function openCreateRole() {
  editingRole.value = null;
  roleForm.value = { name: '', description: '', isDefault: false };
  showRoleModal.value = true;
}

function openEditRole(role: AppRole) {
  editingRole.value = role;
  roleForm.value = { name: role.name, description: role.description ?? '', isDefault: role.isDefault };
  showRoleModal.value = true;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : t('appDetail.operationFailed');
}

async function refreshRoles() {
  roles.value = (await appsApi.listRoles(props.appId)).roles;
}

async function saveRole() {
  saving.value = true;
  try {
    const description = roleForm.value.description.trim();
    if (editingRole.value) {
      await appsApi.updateRole(props.appId, editingRole.value.id, {
        description: description || null,
        isDefault: roleForm.value.isDefault,
      });
      toast.success(t('appDetail.roleUpdated'));
    } else {
      await appsApi.createRole(props.appId, {
        name: roleForm.value.name.trim(),
        description: description || undefined,
        isDefault: roleForm.value.isDefault,
      });
      toast.success(t('appDetail.roleCreated'));
    }
    await refreshRoles();
    showRoleModal.value = false;
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    saving.value = false;
  }
}

async function deleteRole() {
  const role = roleToDelete.value;
  if (!role) return;
  saving.value = true;
  try {
    await appsApi.deleteRole(props.appId, role.id);
    roles.value = roles.value.filter((r) => r.id !== role.id);
    toast.success(t('appDetail.roleDeleted'));
    roleToDelete.value = null;
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    saving.value = false;
  }
}

// ── Permissions ────────────────────────────────────────────────────────────────
const showPermModal = ref(false);
const permForm = ref<{ resource: string; action: 'read' | 'write' }>({ resource: '', action: 'read' });
const permToDelete = ref<AppPermission | null>(null);

const actionSelectOptions = computed<SelectOption[]>(() => [
  { value: 'read', label: t('appDetail.read'), description: t('appDetail.readDesc'), icon: Eye },
  { value: 'write', label: t('appDetail.write'), description: t('appDetail.writeDesc'), icon: Pencil },
]);

function openCreatePermission() {
  permForm.value = { resource: '', action: 'read' };
  showPermModal.value = true;
}

async function createPermission() {
  saving.value = true;
  try {
    await appsApi.createPermission(props.appId, { ...permForm.value, resource: permForm.value.resource.trim() });
    permissions.value = (await appsApi.listPermissions(props.appId)).permissions;
    toast.success(t('appDetail.permissionCreated'));
    showPermModal.value = false;
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    saving.value = false;
  }
}

async function deletePermission() {
  const permission = permToDelete.value;
  if (!permission) return;
  saving.value = true;
  try {
    await appsApi.deletePermission(props.appId, permission.id);
    permissions.value = permissions.value.filter((p) => p.id !== permission.id);
    // The server drops the assignments with the permission; mirror it locally.
    roles.value = roles.value.map((r) => ({
      ...r,
      permissionIds: r.permissionIds.filter((id) => id !== permission.id),
    }));
    toast.success(t('appDetail.permissionDeleted'));
    permToDelete.value = null;
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    saving.value = false;
  }
}

// ── Matrix ─────────────────────────────────────────────────────────────────────
async function togglePermission(roleId: string, permissionId: string, assigned: boolean) {
  const key = `${roleId}:${permissionId}`;
  if (pending.value.has(key)) return;
  pending.value = new Set(pending.value).add(key);
  try {
    if (assigned) await appsApi.removePermissionFromRole(props.appId, roleId, permissionId);
    else await appsApi.assignPermissionToRole(props.appId, roleId, permissionId);
    roles.value = roles.value.map((r) =>
      r.id !== roleId
        ? r
        : {
            ...r,
            permissionIds: assigned
              ? r.permissionIds.filter((id) => id !== permissionId)
              : [...r.permissionIds, permissionId],
          },
    );
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    const next = new Set(pending.value);
    next.delete(key);
    pending.value = next;
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
</script>

<template>
  <div class="space-y-5">
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <section class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <header class="px-5 py-4 border-b border-surface-700/40 flex items-center justify-between">
          <h3 class="text-sm font-semibold text-surface-200">{{ t('appDetail.roles') }}</h3>
          <BaseButton size="sm" @click="openCreateRole"><Plus class="w-3.5 h-3.5" />{{ t('appDetail.createRole') }}</BaseButton>
        </header>
        <p v-if="!roles.length" class="px-5 py-8 text-center text-sm text-surface-500">{{ t('appDetail.noRoles') }}</p>
        <ul v-else class="divide-y divide-surface-800/40 max-h-[28rem] overflow-y-auto">
          <li v-for="role in roles" :key="role.id" class="px-5 py-4 flex items-center gap-4 group">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium text-surface-200 truncate">{{ role.name }}</p>
                <BaseBadge v-if="role.isDefault" variant="primary" size="sm">{{ t('appDetail.defaultBadge') }}</BaseBadge>
              </div>
              <p class="text-xs text-surface-500 mt-0.5 truncate">{{ role.description ?? '—' }}</p>
            </div>
            <span class="text-xs text-surface-500 whitespace-nowrap">{{ t('appDetail.permissionCount', role.permissionIds.length) }}</span>
            <div class="flex items-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button
                type="button"
                :aria-label="t('appDetail.editRole')"
                :title="t('appDetail.editRole')"
                class="p-1.5 rounded-lg text-surface-400 hover:text-surface-100 hover:bg-surface-700/50 transition-colors"
                @click="openEditRole(role)"
              >
                <Pencil class="w-4 h-4" />
              </button>
              <button
                type="button"
                :aria-label="t('appDetail.deleteRole')"
                :title="t('appDetail.deleteRole')"
                class="p-1.5 rounded-lg text-red-500 hover:bg-red-500/10 transition-colors"
                @click="roleToDelete = role"
              >
                <Trash2 class="w-4 h-4" />
              </button>
            </div>
          </li>
        </ul>
      </section>

      <section class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
        <header class="px-5 py-4 border-b border-surface-700/40 flex items-center justify-between">
          <h3 class="text-sm font-semibold text-surface-200">{{ t('appDetail.permissions') }}</h3>
          <BaseButton size="sm" @click="openCreatePermission"><Plus class="w-3.5 h-3.5" />{{ t('appDetail.createPermission') }}</BaseButton>
        </header>
        <p v-if="!permissions.length" class="px-5 py-8 text-center text-sm text-surface-500">{{ t('appDetail.noPermissions') }}</p>
        <ul v-else class="divide-y divide-surface-800/40 max-h-[28rem] overflow-y-auto">
          <li v-for="perm in permissions" :key="perm.id" class="px-5 py-3 flex items-center gap-4 group">
            <code class="flex-1 min-w-0 truncate text-sm font-mono text-surface-300">{{ perm.resource }}:<span :class="perm.action === 'write' ? 'text-amber-400' : 'text-emerald-400'">{{ perm.action }}</span></code>
            <span class="text-xs text-surface-600">{{ formatDate(perm.createdAt) }}</span>
            <button
              type="button"
              :aria-label="t('appDetail.deletePermission')"
              :title="t('appDetail.deletePermission')"
              class="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-lg text-red-500 hover:bg-red-500/10 transition-all"
              @click="permToDelete = perm"
            >
              <Trash2 class="w-4 h-4" />
            </button>
          </li>
        </ul>
      </section>
    </div>

    <PermissionMatrix
      v-if="roles.length && permissions.length"
      :app-name="appName"
      :roles="roles"
      :permissions="permissions"
      :pending="pending"
      @toggle="togglePermission"
    />

    <BaseModal
      :open="showRoleModal"
      :title="editingRole ? t('appDetail.editRole') : t('appDetail.createRole')"
      @close="showRoleModal = false"
    >
      <div class="space-y-4">
        <BaseInput
          v-model="roleForm.name"
          :label="t('appDetail.roleName')"
          :hint="editingRole ? t('appDetail.roleNameLocked') : undefined"
          :disabled="!!editingRole"
          required
        />
        <BaseInput v-model="roleForm.description" :label="t('appDetail.roleDescription')" />
        <BaseToggle v-model="roleForm.isDefault" :label="t('appDetail.isDefault')" />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showRoleModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="saving" :disabled="!editingRole && roleForm.name.trim() === ''" @click="saveRole">
          {{ editingRole ? t('common.save') : t('common.create') }}
        </BaseButton>
      </template>
    </BaseModal>

    <BaseModal :open="showPermModal" :title="t('appDetail.createPermission')" @close="showPermModal = false">
      <div class="space-y-4">
        <BaseInput v-model="permForm.resource" :label="t('appDetail.resource')" placeholder="documents" required />
        <BaseSelect
          v-model="permForm.action"
          :label="t('appDetail.action')"
          :options="actionSelectOptions"
        />
      </div>
      <template #footer>
        <BaseButton variant="ghost" @click="showPermModal = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton :loading="saving" :disabled="permForm.resource.trim() === ''" @click="createPermission">{{ t('common.create') }}</BaseButton>
      </template>
    </BaseModal>

    <ConfirmDialog
      :open="!!roleToDelete"
      :title="t('appDetail.deleteRole')"
      :message="t('appDetail.confirmDeleteRole')"
      :loading="saving"
      @confirm="deleteRole"
      @cancel="roleToDelete = null"
    />
    <ConfirmDialog
      :open="!!permToDelete"
      :title="t('appDetail.deletePermission')"
      :message="t('appDetail.confirmDeletePermission')"
      :loading="saving"
      @confirm="deletePermission"
      @cancel="permToDelete = null"
    />
  </div>
</template>
