<script setup lang="ts">
    import { ref, computed, watch } from "vue";
    import { useI18n } from "vue-i18n";
    import { Plus, Trash2, ChevronRight, ChevronDown } from "lucide-vue-next";

    const props = defineProps<{ appId: string; }>();
    const { t } = useI18n();

    interface RoleWithPermissions {
        id: string;
        name: string;
        description?: string;
        permissionIds: string[];
    }
    interface Permission {
        id: string;
        resource: string;
        action: string;
    }

    const roles = ref<RoleWithPermissions[]>([]);
    const permissions = ref<Permission[]>([]);
    const newRoleName = ref("");
    const newPermResource = ref("");
    const expandedRoleId = ref<string | null>(null);

    const uniqueResources = computed((): string[] => {
        const seen = new Set<string>();
        for (const p of permissions.value) seen.add(p.resource);
        return [...seen].sort();
    });

    const permByResource = computed(
        (): Map<string, { read?: Permission; write?: Permission; }> => {
            const map = new Map<string, { read?: Permission; write?: Permission; }>();
            for (const p of permissions.value) {
                const entry = map.get(p.resource) ?? {};
                if (p.action === "read") entry.read = p;
                else entry.write = p;
                map.set(p.resource, entry);
            }
            return map;
        },
    );

    const rolePermSet = computed((): Map<string, Set<string>> => {
        const map = new Map<string, Set<string>>();
        for (const role of roles.value) map.set(role.id, new Set(role.permissionIds));
        return map;
    });

    async function fetchData() {
        const [rolesRes, permsRes] = await Promise.all([
            fetch(`/api/admin/applications/${props.appId}/roles`, { credentials: "include" }),
            fetch(`/api/admin/applications/${props.appId}/permissions`, { credentials: "include" }),
        ]);
        roles.value = ((await rolesRes.json()) as { roles: RoleWithPermissions[]; }).roles;
        permissions.value = ((await permsRes.json()) as { permissions: Permission[]; }).permissions;
    }

    async function addRole() {
        if (!newRoleName.value.trim()) return;
        await fetch(`/api/admin/applications/${props.appId}/roles`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ name: newRoleName.value.trim() }),
        });
        newRoleName.value = "";
        await fetchData();
    }

    async function deleteRole(id: string) {
        if (expandedRoleId.value === id) expandedRoleId.value = null;
        await fetch(`/api/admin/applications/${props.appId}/roles/${id}`, {
            method: "DELETE",
            credentials: "include",
        });
        await fetchData();
    }

    async function addResource() {
        const resource = newPermResource.value.trim();
        if (!resource) return;
        await Promise.all([
            fetch(`/api/admin/applications/${props.appId}/permissions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ resource, action: "read" }),
            }),
            fetch(`/api/admin/applications/${props.appId}/permissions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ resource, action: "write" }),
            }),
        ]);
        newPermResource.value = "";
        await fetchData();
    }

    async function deleteResource(resource: string) {
        const entry = permByResource.value.get(resource);
        if (!entry) return;
        const deletes: Promise<Response>[] = [];
        if (entry.read)
            deletes.push(
                fetch(`/api/admin/applications/${props.appId}/permissions/${entry.read.id}`, {
                    method: "DELETE",
                    credentials: "include",
                }),
            );
        if (entry.write)
            deletes.push(
                fetch(`/api/admin/applications/${props.appId}/permissions/${entry.write.id}`, {
                    method: "DELETE",
                    credentials: "include",
                }),
            );
        await Promise.all(deletes);
        await fetchData();
    }

    function hasPermission(roleId: string, permId: string): boolean {
        return rolePermSet.value.get(roleId)?.has(permId) ?? false;
    }

    async function togglePermission(roleId: string, perm: Permission) {
        if (hasPermission(roleId, perm.id)) {
            await fetch(
                `/api/admin/applications/${props.appId}/roles/${roleId}/permissions/${perm.id}`,
                { method: "DELETE", credentials: "include" },
            );
        } else {
            await fetch(`/api/admin/applications/${props.appId}/roles/${roleId}/permissions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ permissionId: perm.id }),
            });
        }
        await fetchData();
    }

    watch(() => props.appId, fetchData, { immediate: true });
</script>

<template>
    <div class="space-y-6">
        <div class="grid gap-6" style="grid-template-columns: 2fr 3fr; align-items: start">
            <!-- ── Left: Permission resources ────────────────────────────────────── -->
            <div class="card space-y-4">
                <div>
                    <h2 class="text-sm font-semibold">{{ t("admin.permissions") }}</h2>
                    <p class="text-xs mt-1" style="color: var(--text-muted)">
                        {{ t("admin.resourceHint") }}
                    </p>
                </div>
                <div class="flex gap-2">
                    <input v-model="newPermResource" class="input flex-1 text-sm font-mono"
                        :placeholder="t('admin.resourcePlaceholder')" @keyup.enter="addResource" />
                    <button class="btn btn-primary px-3" :title="t('admin.addResource')" @click="addResource">
                        <Plus class="w-4 h-4" />
                    </button>
                </div>

                <div v-if="uniqueResources.length === 0" class="text-xs text-center py-4"
                    style="color: var(--text-muted)">
                    {{ t("admin.noPermissions") }}
                </div>
                <ul v-else class="space-y-1.5">
                    <li v-for="resource in uniqueResources" :key="resource"
                        class="flex items-center justify-between px-3 py-2 rounded-lg"
                        style="background: var(--bg-secondary)">
                        <div>
                            <span class="text-sm font-mono">{{ resource }}</span>
                            <div class="flex items-center gap-1.5 mt-0.5">
                                <span class="badge badge-inactive" style="font-size: 0.6rem; padding: 1px 5px">
                                    read
                                </span>
                                <span class="badge badge-inactive" style="font-size: 0.6rem; padding: 1px 5px">
                                    write
                                </span>
                            </div>
                        </div>
                        <button class="btn btn-ghost p-1 shrink-0" @click="deleteResource(resource)">
                            <Trash2 class="w-3.5 h-3.5" style="color: #f87171" />
                        </button>
                    </li>
                </ul>
            </div>

            <!-- ── Right: Roles with permission matrix ─────────────────────────── -->
            <div class="card space-y-4">
                <h2 class="text-sm font-semibold">{{ t("admin.roles") }}</h2>
                <div class="flex gap-2">
                    <input v-model="newRoleName" class="input flex-1 text-sm" placeholder="editor"
                        @keyup.enter="addRole" />
                    <button class="btn btn-primary px-3" @click="addRole">
                        <Plus class="w-4 h-4" />
                    </button>
                </div>

                <div v-if="roles.length === 0" class="text-xs text-center py-4" style="color: var(--text-muted)">
                    Aucun rôle pour l'instant.
                </div>
                <ul v-else class="space-y-2">
                    <li v-for="role in roles" :key="role.id" class="rounded-lg overflow-hidden"
                        style="border: 1px solid var(--border)">
                        <!-- Role header -->
                        <div class="flex items-center justify-between px-3 py-2"
                            style="background: var(--bg-secondary)">
                            <button class="flex items-center gap-2 flex-1 min-w-0 text-left"
                                @click="expandedRoleId = expandedRoleId === role.id ? null : role.id">
                                <component :is="expandedRoleId === role.id ? ChevronDown : ChevronRight"
                                    class="w-3.5 h-3.5 shrink-0" style="color: var(--text-muted)" />
                                <span class="text-sm font-mono truncate">{{ role.name }}</span>
                                <span v-if="role.permissionIds.length > 0" class="badge badge-success shrink-0"
                                    style="font-size: 0.6rem; padding: 1px 6px">
                                    {{ role.permissionIds.length }}
                                </span>
                            </button>
                            <button class="btn btn-ghost p-1 ml-2 shrink-0" @click="deleteRole(role.id)">
                                <Trash2 class="w-3.5 h-3.5" style="color: #f87171" />
                            </button>
                        </div>

                        <!-- Permission matrix (expandable) -->
                        <Transition name="expand">
                            <div v-if="expandedRoleId === role.id">
                                <div v-if="uniqueResources.length === 0" class="px-4 py-3 text-xs"
                                    style="color: var(--text-muted)">
                                    {{ t("admin.configurePermissions") }}
                                </div>
                                <table v-else class="w-full text-xs">
                                    <thead>
                                        <tr style="border-bottom: 1px solid var(--border)">
                                            <th class="text-left px-4 py-2 font-medium"
                                                style="color: var(--text-muted)">
                                                Resource
                                            </th>
                                            <th class="px-4 py-2 font-medium text-center"
                                                style="color: var(--text-muted); width: 80px">
                                                {{ t("admin.readAccess") }}
                                            </th>
                                            <th class="px-4 py-2 font-medium text-center"
                                                style="color: var(--text-muted); width: 80px">
                                                {{ t("admin.writeAccess") }}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="resource in uniqueResources" :key="resource"
                                            style="border-bottom: 1px solid var(--border)">
                                            <td class="px-4 py-2 font-mono">{{ resource }}</td>
                                            <td class="px-4 py-2 text-center">
                                                <template v-if="permByResource.get(resource)?.read">
                                                    <button type="button"
                                                        class="inline-flex w-9 h-5 rounded-full transition-colors"
                                                        :style="hasPermission(
                                                            role.id,
                                                            permByResource.get(resource)!.read!.id,
                                                        )
                                                                ? 'background: var(--accent-cyan)'
                                                                : 'background: var(--border)'
                                                            " @click="togglePermission(role.id, permByResource.get(resource)!.read!)">
                                                        <span
                                                            class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                                            :style="hasPermission(
                                                                role.id,
                                                                permByResource.get(resource)!.read!.id,
                                                            )
                                                                    ? 'transform: translateX(1.1rem)'
                                                                    : 'transform: translateX(0.125rem)'
                                                                " />
                                                    </button>
                                                </template>
                                                <span v-else style="color: var(--text-muted)">—</span>
                                            </td>
                                            <td class="px-4 py-2 text-center">
                                                <template v-if="permByResource.get(resource)?.write">
                                                    <button type="button"
                                                        class="inline-flex w-9 h-5 rounded-full transition-colors"
                                                        :style="hasPermission(
                                                            role.id,
                                                            permByResource.get(resource)!.write!.id,
                                                        )
                                                                ? 'background: var(--accent-cyan)'
                                                                : 'background: var(--border)'
                                                            " @click="
                                togglePermission(role.id, permByResource.get(resource)!.write!)
                                ">
                                                        <span
                                                            class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                                            :style="hasPermission(
                                                                role.id,
                                                                permByResource.get(resource)!.write!.id,
                                                            )
                                                                    ? 'transform: translateX(1.1rem)'
                                                                    : 'transform: translateX(0.125rem)'
                                                                " />
                                                    </button>
                                                </template>
                                                <span v-else style="color: var(--text-muted)">—</span>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </Transition>
                    </li>
                </ul>
            </div>
        </div>
    </div>
</template>

<style scoped>

    .expand-enter-active,
    .expand-leave-active {
        transition: opacity 0.15s ease;
        overflow: hidden;
    }

    .expand-enter-from,
    .expand-leave-to {
        opacity: 0;
    }
</style>
