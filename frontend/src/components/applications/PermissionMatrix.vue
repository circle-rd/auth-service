<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Printer, Search, X } from 'lucide-vue-next';
import BaseButton from '@/components/ui/BaseButton.vue';
import { printPermissionMatrix } from '@/utils/printPermissionMatrix';
import type { AppPermission, AppRole } from '@/types';

// Above this many roles the column headers are turned sideways to keep columns narrow.
const SIDEWAYS_HEADER_THRESHOLD = 6;

const props = defineProps<{
  appName: string;
  roles: AppRole[];
  permissions: AppPermission[];
  /** Keys (`roleId:permissionId`) whose toggle request is in flight. */
  pending: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  toggle: [roleId: string, permissionId: string, assigned: boolean];
}>();

const { t } = useI18n();
const permissionQuery = ref('');
const roleQuery = ref('');

const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
const actionOrder = (action: AppPermission['action']) => (action === 'read' ? 0 : 1);

function groupByResource(permissions: AppPermission[]) {
  const byResource = new Map<string, AppPermission[]>();
  for (const permission of permissions) {
    const list = byResource.get(permission.resource);
    if (list) list.push(permission);
    else byResource.set(permission.resource, [permission]);
  }
  return [...byResource.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([resource, list]) => ({
      resource,
      permissions: [...list].sort((a, b) => actionOrder(a.action) - actionOrder(b.action)),
    }));
}

const groups = computed(() => {
  const query = permissionQuery.value.trim().toLowerCase();
  return groupByResource(
    props.permissions.filter((p) => !query || `${p.resource}:${p.action}`.toLowerCase().includes(query)),
  );
});

const visibleRoles = computed(() => {
  const query = roleQuery.value.trim().toLowerCase();
  return props.roles.filter((r) => !query || r.name.toLowerCase().includes(query));
});

const visiblePermissionCount = computed(() => groups.value.reduce((sum, g) => sum + g.permissions.length, 0));
const sideways = computed(() => visibleRoles.value.length > SIDEWAYS_HEADER_THRESHOLD);
const columnCount = computed(() => visibleRoles.value.length + 1);

function isAssigned(role: AppRole, permission: AppPermission): boolean {
  return role.permissionIds.includes(permission.id);
}

function print(): void {
  const roles = props.roles;
  printPermissionMatrix({
    title: t('appDetail.matrixPrintTitle'),
    appName: props.appName,
    printedAt: t('appDetail.matrixPrintedAt', { date: new Date().toLocaleString() }),
    permissionHeader: t('appDetail.permissionColumn'),
    rolesHeader: t('appDetail.matrixRolesTotal'),
    defaultLabel: t('appDetail.defaultBadge'),
    legend: { granted: t('appDetail.matrixGranted'), denied: t('appDetail.matrixDenied') },
    roles: roles.map((r) => ({ name: r.name, isDefault: r.isDefault, permissionCount: r.permissionIds.length })),
    groups: groupByResource(props.permissions).map((g) => ({
      resource: g.resource,
      rows: g.permissions.map((p) => ({
        action: p.action,
        granted: roles.map((r) => isAssigned(r, p)),
        roleCount: roles.filter((r) => isAssigned(r, p)).length,
      })),
    })),
  });
}
</script>

<template>
  <section class="rounded-2xl bg-surface-900/60 border border-surface-700/40 overflow-hidden">
    <header class="px-5 py-4 border-b border-surface-700/40 flex flex-wrap items-center gap-3">
      <div class="mr-auto">
        <h3 class="text-sm font-semibold text-surface-200">{{ t('appDetail.permissionMatrix') }}</h3>
        <p class="text-xs text-surface-500 mt-0.5">
          {{ t('appDetail.matrixSummary', { roles: roles.length, permissions: permissions.length }) }}
        </p>
      </div>
      <label class="relative">
        <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500" />
        <input
          v-model="permissionQuery"
          :placeholder="t('appDetail.matrixFilterPermissions')"
          :aria-label="t('appDetail.matrixFilterPermissions')"
          class="w-48 pl-8 pr-3 py-1.5 text-xs bg-surface-800 border border-surface-600 rounded-lg text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500"
        />
      </label>
      <label class="relative">
        <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-500" />
        <input
          v-model="roleQuery"
          :placeholder="t('appDetail.matrixFilterRoles')"
          :aria-label="t('appDetail.matrixFilterRoles')"
          class="w-40 pl-8 pr-3 py-1.5 text-xs bg-surface-800 border border-surface-600 rounded-lg text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500"
        />
      </label>
      <BaseButton size="sm" variant="outline" @click="print">
        <Printer class="w-3.5 h-3.5" />{{ t('appDetail.matrixPrint') }}
      </BaseButton>
    </header>

    <p v-if="!visibleRoles.length || !visiblePermissionCount" class="px-5 py-8 text-center text-sm text-surface-500">
      {{ t('appDetail.matrixNoMatch') }}
    </p>

    <div v-else class="max-h-[70vh] overflow-auto">
      <table :class="['border-separate border-spacing-0', sideways ? '' : 'min-w-full']">
        <thead>
          <tr>
            <th class="sticky top-0 left-0 z-30 bg-surface-900 border-b border-r border-surface-800/60 px-5 py-3 text-left text-xs font-medium text-surface-500 align-bottom">
              {{ t('appDetail.permissionColumn') }}
            </th>
            <th
              v-for="role in visibleRoles"
              :key="role.id"
              :title="`${role.name} · ${t('appDetail.permissionCount', role.permissionIds.length)}`"
              :class="[
                'sticky top-0 z-20 bg-surface-900 border-b border-surface-800/60 text-xs font-medium text-surface-400',
                sideways ? 'px-1 py-3 w-11 min-w-11 align-bottom' : 'px-4 py-3 min-w-24 text-center',
              ]"
            >
              <span v-if="sideways" class="inline-block max-h-40 truncate [writing-mode:vertical-rl] rotate-180 whitespace-nowrap">
                {{ role.name }}
              </span>
              <template v-else>{{ role.name }}</template>
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-for="group in groups" :key="group.resource">
            <tr>
              <th
                :colspan="columnCount"
                class="sticky left-0 bg-surface-950/80 border-b border-surface-800/60 px-5 py-1.5 text-left text-[11px] font-mono font-semibold uppercase tracking-wide text-surface-400"
              >
                {{ group.resource }}
              </th>
            </tr>
            <tr v-for="permission in group.permissions" :key="permission.id" class="group/row hover:bg-surface-800/30">
              <td class="sticky left-0 z-10 bg-surface-900 group-hover/row:bg-surface-800 border-b border-r border-surface-800/40 px-5 py-2 whitespace-nowrap">
                <code class="text-xs font-mono text-surface-300">
                  {{ permission.resource }}:<span :class="permission.action === 'write' ? 'text-amber-400' : 'text-emerald-400'">{{ permission.action }}</span>
                </code>
              </td>
              <td v-for="role in visibleRoles" :key="role.id" class="border-b border-surface-800/40 px-1 py-2 text-center">
                <button
                  type="button"
                  role="switch"
                  :aria-checked="isAssigned(role, permission)"
                  :aria-label="t('appDetail.matrixToggle', { role: role.name, permission: `${permission.resource}:${permission.action}` })"
                  :disabled="pending.has(`${role.id}:${permission.id}`)"
                  :class="[
                    'w-6 h-6 rounded-md flex items-center justify-center mx-auto transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 disabled:opacity-40 disabled:cursor-wait',
                    isAssigned(role, permission)
                      ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                      : 'bg-surface-800 text-surface-600 hover:bg-surface-700',
                  ]"
                  @click="emit('toggle', role.id, permission.id, isAssigned(role, permission))"
                >
                  <Check v-if="isAssigned(role, permission)" class="w-3.5 h-3.5" />
                  <X v-else class="w-3.5 h-3.5" />
                </button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </section>
</template>
