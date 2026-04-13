<script setup lang="ts">
    import { ref, computed, watch } from "vue";
    import { useI18n } from "vue-i18n";
    import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-vue-next";

    const props = defineProps<{ appId: string; }>();
    const { t } = useI18n();

    interface GlobalUser {
        id: string;
        name: string;
        email: string;
        company?: string | null;
    }
    interface AppUser {
        userId: string;
        name?: string | null;
        email?: string | null;
        isActive: boolean;
        subscriptionPlanId?: string | null;
        roleId?: string | null;
    }
    interface Role {
        id: string;
        name: string;
    }
    interface Plan {
        id: string;
        name: string;
    }

    const allUsers = ref<GlobalUser[]>([]);
    const appUsers = ref<AppUser[]>([]);
    const roles = ref<Role[]>([]);
    const plans = ref<Plan[]>([]);
    const userSearch = ref("");
    const loading = ref(false);

    // Sorting
    type SortField = "name" | "email" | "company";
    const sortBy = ref<SortField>("name");
    const sortDir = ref<"asc" | "desc">("asc");

    function setSort(field: SortField) {
        if (sortBy.value === field) sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
        else { sortBy.value = field; sortDir.value = "asc"; }
    }

    const appUserMap = computed((): Map<string, AppUser> => {
        const m = new Map<string, AppUser>();
        for (const u of appUsers.value) m.set(u.userId, u);
        return m;
    });

    const filteredUsers = computed(() => {
        const q = userSearch.value.toLowerCase();
        const list = q
            ? allUsers.value.filter(
                (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) ||
                    (u.company ?? "").toLowerCase().includes(q),
            )
            : allUsers.value.slice();

        list.sort((a, b) => {
            let va: string, vb: string;
            if (sortBy.value === "company") {
                va = (a.company ?? "").toLowerCase();
                vb = (b.company ?? "").toLowerCase();
            } else {
                va = (a[sortBy.value] ?? "").toLowerCase();
                vb = (b[sortBy.value] ?? "").toLowerCase();
            }
            const cmp = va < vb ? -1 : va > vb ? 1 : 0;
            return sortDir.value === "asc" ? cmp : -cmp;
        });
        return list;
    });

    function isUserInApp(userId: string): boolean {
        return appUserMap.value.has(userId);
    }

    function initials(name: string | null | undefined): string {
        if (!name) return "?";
        return name
            .split(" ")
            .map((p) => p[0])
            .join("")
            .toUpperCase()
            .slice(0, 2);
    }

    async function fetchData() {
        loading.value = true;
        try {
            const [allRes, appRes, rolesRes, plansRes] = await Promise.all([
                fetch(`/api/admin/users?limit=500`, { credentials: "include" }),
                fetch(`/api/admin/applications/${props.appId}/users`, { credentials: "include" }),
                fetch(`/api/admin/applications/${props.appId}/roles`, { credentials: "include" }),
                fetch(`/api/admin/applications/${props.appId}/plans`, { credentials: "include" }),
            ]);
            allUsers.value = ((await allRes.json()) as { users: GlobalUser[]; }).users;
            appUsers.value = ((await appRes.json()) as { users: AppUser[]; }).users;
            roles.value = ((await rolesRes.json()) as { roles: Role[]; }).roles;
            plans.value = ((await plansRes.json()) as { plans: Plan[]; }).plans;
        } finally {
            loading.value = false;
        }
    }

    async function toggleUserAccess(userId: string) {
        if (isUserInApp(userId)) {
            await fetch(`/api/admin/applications/${props.appId}/users/${userId}`, {
                method: "DELETE",
                credentials: "include",
            });
        } else {
            await fetch(`/api/admin/applications/${props.appId}/users`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ userId }),
            });
        }
        await fetchData();
    }

    async function updateUserRole(userId: string, roleId: string | null) {
        await fetch(`/api/admin/applications/${props.appId}/users/${userId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ roleId }),
        });
        await fetchData();
    }

    async function updateUserPlan(userId: string, planId: string | null) {
        await fetch(`/api/admin/applications/${props.appId}/users/${userId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ subscriptionPlanId: planId }),
        });
        await fetchData();
    }

    watch(() => props.appId, fetchData, { immediate: true });
</script>

<template>
    <div class="space-y-5">
        <div class="flex items-center justify-between gap-4 flex-wrap">
            <h1 class="text-xl font-semibold gradient-text">{{ t("admin.users") }}</h1>
            <input v-model="userSearch" class="input" style="max-width: 280px" :placeholder="t('common.search')" />
        </div>

        <div v-if="loading" class="text-sm py-10 text-center" style="color: var(--color-text-muted)">
            {{ t("common.loading") }}
        </div>

        <div v-else class="card !p-0 overflow-x-auto">
            <table class="w-full text-sm">
                <thead>
                    <tr style="border-bottom: 1px solid var(--color-border)">
                        <th class="text-left px-4 py-3 cursor-pointer select-none"
                            style="color: var(--color-text-muted)" @click="setSort('name')">
                            <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                                {{ t("common.name") }}
                                <ChevronsUpDown v-if="sortBy !== 'name'" class="w-3 h-3 opacity-40" />
                                <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                                <ChevronDown v-else class="w-3 h-3" />
                            </span>
                        </th>
                        <th class="text-left px-4 py-3 cursor-pointer select-none hidden sm:table-cell"
                            style="color: var(--color-text-muted)" @click="setSort('company')">
                            <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                                {{ t("profile.company") }}
                                <ChevronsUpDown v-if="sortBy !== 'company'" class="w-3 h-3 opacity-40" />
                                <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                                <ChevronDown v-else class="w-3 h-3" />
                            </span>
                        </th>
                        <th class="text-left px-4 py-3 font-medium text-xs uppercase tracking-wide"
                            style="color: var(--color-text-muted)">
                            {{ t("common.status") }}
                        </th>
                        <th class="text-left px-4 py-3 font-medium text-xs uppercase tracking-wide"
                            style="color: var(--color-text-muted)">
                            {{ t("common.role") }}
                        </th>
                        <th class="text-left px-4 py-3 font-medium text-xs uppercase tracking-wide"
                            style="color: var(--color-text-muted)">
                            {{ t("admin.plans") }}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="user in filteredUsers" :key="user.id" style="border-bottom: 1px solid var(--color-border)"
                        :style="{ opacity: isUserInApp(user.id) ? '1' : '0.5' }" class="transition-opacity">
                        <!-- Name + email -->
                        <td class="px-4 py-3">
                            <div class="flex items-center gap-2.5">
                                <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                                    style="background: var(--color-primary-light); color: var(--color-primary)">
                                    {{ initials(user.name) }}
                                </div>
                                <div>
                                    <p class="font-medium leading-tight">{{ user.name }}</p>
                                    <p class="text-xs" style="color: var(--color-text-muted)">{{ user.email }}</p>
                                </div>
                            </div>
                        </td>

                        <!-- Company -->
                        <td class="px-4 py-3 hidden sm:table-cell">
                            <span v-if="user.company" class="text-sm">{{ user.company }}</span>
                            <span v-else class="text-xs" style="color: var(--color-text-muted)">—</span>
                        </td>

                        <!-- Toggle access -->
                        <td class="px-4 py-3">
                            <button type="button" class="flex items-center gap-2 cursor-pointer"
                                @click="toggleUserAccess(user.id)">
                                <div class="w-9 h-5 rounded-full transition-colors shrink-0" :style="isUserInApp(user.id)
                                        ? 'background: var(--color-primary)'
                                        : 'background: var(--color-border)'
                                    ">
                                    <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                        :style="isUserInApp(user.id)
                                                ? 'transform: translateX(1.1rem)'
                                                : 'transform: translateX(0.125rem)'
                                            " />
                                </div>
                                <span class="text-xs" style="color: var(--color-text-muted)">
                                    {{ isUserInApp(user.id) ? t("common.active") : t("common.inactive") }}
                                </span>
                            </button>
                        </td>

                        <!-- Role select -->
                        <td class="px-4 py-3">
                            <select v-if="isUserInApp(user.id)" class="select text-xs py-1"
                                :value="appUserMap.get(user.id)?.roleId ?? ''" @change="
                                    updateUserRole(user.id, ($event.target as HTMLSelectElement).value || null)
                                    ">
                                <option value="">{{ t("admin.noRole") }}</option>
                                <option v-for="role in roles" :key="role.id" :value="role.id">
                                    {{ role.name }}
                                </option>
                            </select>
                            <span v-else class="text-xs" style="color: var(--color-text-muted)">—</span>
                        </td>

                        <!-- Plan select -->
                        <td class="px-4 py-3">
                            <select v-if="isUserInApp(user.id)" class="select text-xs py-1"
                                :value="appUserMap.get(user.id)?.subscriptionPlanId ?? ''" @change="
                                    updateUserPlan(user.id, ($event.target as HTMLSelectElement).value || null)
                                    ">
                                <option value="">{{ t("admin.noPlan") }}</option>
                                <option v-for="plan in plans" :key="plan.id" :value="plan.id">
                                    {{ plan.name }}
                                </option>
                            </select>
                            <span v-else class="text-xs" style="color: var(--color-text-muted)">—</span>
                        </td>
                    </tr>
                    <tr v-if="filteredUsers.length === 0">
                        <td colspan="5" class="px-4 py-10 text-center text-sm" style="color: var(--color-text-muted)">
                            No users found.
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>
