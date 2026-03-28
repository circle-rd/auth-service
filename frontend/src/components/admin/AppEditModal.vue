<script setup lang="ts">
    import { ref, watch, onMounted, onUnmounted } from "vue";
    import { useI18n } from "vue-i18n";
    import {
        X,
        LayoutGrid,
        Shield,
        CreditCard,
        Users,
        BarChart2,
    } from "lucide-vue-next";
    import AppInfoTab from "./AppInfoTab.vue";
    import AppRolesTab from "./AppRolesTab.vue";
    import AppSubscriptionsTab from "./AppSubscriptionsTab.vue";
    import AppUsersTab from "./AppUsersTab.vue";
    import AppConsumptionTab from "./AppConsumptionTab.vue";

    const props = defineProps<{
        appId: string;
        open: boolean;
    }>();

    const emit = defineEmits<{
        close: [];
        updated: [];
    }>();

    const { t } = useI18n();

    type Tab = "info" | "roles" | "subscriptions" | "users" | "consumption";
    const activeTab = ref<Tab>("info");

    const tabs: { id: Tab; label: string; shortLabel: string; icon: typeof LayoutGrid; }[] = [
        { id: "info", label: "admin.generalInfo", shortLabel: "Info", icon: LayoutGrid },
        { id: "roles", label: "admin.roles", shortLabel: "Rôles", icon: Shield },
        { id: "subscriptions", label: "admin.subscriptions", shortLabel: "Plans", icon: CreditCard },
        { id: "users", label: "admin.users", shortLabel: "Users", icon: Users },
        { id: "consumption", label: "admin.consumptionTab", shortLabel: "Stats", icon: BarChart2 },
    ];

    interface AppSummary {
        name: string;
        slug: string;
        icon?: string | null;
    }
    const appSummary = ref<AppSummary | null>(null);

    async function fetchSummary() {
        const res = await fetch(`/api/admin/applications/${props.appId}`, {
            credentials: "include",
        });
        const data = (await res.json()) as { application: AppSummary; };
        appSummary.value = data.application;
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

    watch(
        () => props.open,
        (open) => {
            if (open) {
                activeTab.value = "info";
                void fetchSummary();
            }
        },
        { immediate: true },
    );

    function onInfoUpdated() {
        void fetchSummary();
        emit("updated");
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") emit("close");
    }
    onMounted(() => document.addEventListener("keydown", handleKeydown));
    onUnmounted(() => document.removeEventListener("keydown", handleKeydown));
</script>

<template>
    <Teleport to="body">
        <Transition name="modal-fade">
            <div v-if="open" class="fixed inset-0 z-50 flex flex-col lg:flex-row" style="background: var(--bg-primary)">

                <!-- Mobile horizontal tab bar -->
                <div class="flex lg:hidden shrink-0 items-center"
                    style="border-bottom: 1px solid var(--border); background: var(--bg-primary)">
                    <div class="flex items-center gap-2 px-4 py-2 shrink-0">
                        <img v-if="appSummary?.icon" :src="appSummary.icon" :alt="appSummary?.name"
                            class="w-6 h-6 rounded shrink-0 object-cover" />
                        <div v-else
                            class="w-6 h-6 rounded flex items-center justify-center text-xs font-bold font-mono shrink-0"
                            style="background: rgba(34,211,238,0.1); color: var(--accent-cyan)">
                            {{ initials(appSummary?.name) }}
                        </div>
                        <span class="text-sm font-semibold truncate" style="max-width: 96px">{{ appSummary?.name ?? "…"
                            }}</span>
                    </div>

                    <div class="flex flex-1 overflow-x-auto">
                        <button v-for="tab in tabs" :key="tab.id"
                            class="flex flex-col items-center gap-0.5 px-3 py-2.5 transition-colors shrink-0 relative text-xs"
                            :style="activeTab === tab.id ? 'color: var(--accent-cyan)' : 'color: var(--text-muted)'"
                            @click="activeTab = tab.id">
                            <component :is="tab.icon" class="w-4 h-4" />
                            <span>{{ tab.shortLabel }}</span>
                            <span v-if="activeTab === tab.id" class="absolute bottom-0 left-1 right-1 h-0.5 rounded-t"
                                style="background: var(--accent-cyan)" />
                        </button>
                    </div>

                    <button class="btn btn-ghost p-2.5 shrink-0 mx-2" :title="t('common.cancel')"
                        @click="emit('close')">
                        <X class="w-5 h-5" />
                    </button>
                </div>

                <!-- Desktop sidebar -->
                <aside class="hidden lg:flex flex-col shrink-0"
                    style="width: 220px; border-right: 1px solid var(--border); background: var(--bg-primary); padding: 1.25rem 0.75rem">
                    <div class="px-3 mb-5">
                        <img v-if="appSummary?.icon" :src="appSummary.icon" :alt="appSummary?.name"
                            class="w-8 h-8 rounded-lg mb-2 object-cover" />
                        <div v-else
                            class="w-8 h-8 rounded-lg mb-2 flex items-center justify-center text-xs font-bold font-mono"
                            style="background: rgba(34,211,238,0.1); color: var(--accent-cyan)">
                            {{ initials(appSummary?.name) }}
                        </div>
                        <p class="font-semibold text-sm leading-tight truncate">{{ appSummary?.name ?? "…" }}</p>
                        <p class="text-xs font-mono truncate mt-0.5" style="color: var(--text-muted)">{{
                            appSummary?.slug ?? "" }}</p>
                    </div>

                    <nav class="flex-1 space-y-0.5">
                        <button v-for="tab in tabs" :key="tab.id"
                            :class="['nav-link w-full', activeTab === tab.id ? 'nav-link-active' : '']"
                            @click="activeTab = tab.id">
                            <component :is="tab.icon" class="w-4 h-4 shrink-0" />
                            {{ t(tab.label) }}
                        </button>
                    </nav>

                    <button class="btn btn-ghost w-full mt-4" style="justify-content: flex-start; gap: 0.5rem"
                        @click="emit('close')">
                        <X class="w-4 h-4" />
                        {{ t("common.cancel") }}
                    </button>
                </aside>

                <!-- Main content -->
                <main class="flex-1 overflow-y-auto" style="padding: 2rem 2.5rem">

                    <AppInfoTab v-if="activeTab === 'info'" :app-id="appId" @updated="onInfoUpdated" />

                    <template v-else-if="activeTab === 'roles'">
                        <h1 class="text-xl font-semibold gradient-text mb-6">{{ t("admin.roles") }} &amp; {{
                            t("admin.permissions") }}</h1>
                        <AppRolesTab :app-id="appId" />
                    </template>

                    <AppSubscriptionsTab v-else-if="activeTab === 'subscriptions'" :app-id="appId" />

                    <AppUsersTab v-else-if="activeTab === 'users'" :app-id="appId" />

                    <AppConsumptionTab v-else-if="activeTab === 'consumption'" :app-id="appId" />

                </main>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>

    .modal-fade-enter-active,
    .modal-fade-leave-active {
        transition: opacity 0.18s ease;
    }

    .modal-fade-enter-from,
    .modal-fade-leave-to {
        opacity: 0;
    }
</style>
