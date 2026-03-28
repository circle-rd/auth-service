<script setup lang="ts">
    import { ref, watch, computed, onMounted, onUnmounted } from "vue";
    import { useI18n } from "vue-i18n";
    import { X, LayoutGrid, Link, Shield, Settings, Check } from "lucide-vue-next";

    const props = defineProps<{
        appId: string;
        open: boolean;
    }>();

    const emit = defineEmits<{
        close: [];
        updated: [];
    }>();

    const { t } = useI18n();

    type Tab = "general" | "callbacks" | "scopes" | "options";
    const activeTab = ref<Tab>("general");

    const SCOPES = [
        "openid",
        "profile",
        "email",
        "offline_access",
        "roles",
        "permissions",
        "features",
    ];

    const tabs: { id: Tab; label: string; shortLabel: string; icon: typeof LayoutGrid; }[] = [
        { id: "general", label: "admin.generalInfo", shortLabel: "Général", icon: LayoutGrid },
        { id: "callbacks", label: "admin.redirectUrls", shortLabel: "Callbacks", icon: Link },
        { id: "scopes", label: "admin.allowedScopes", shortLabel: "Scopes", icon: Shield },
        { id: "options", label: "common.actions", shortLabel: "Options", icon: Settings },
    ];

    interface Application {
        id: string;
        name: string;
        slug: string;
        description?: string | null;
        url?: string | null;
        icon?: string | null;
        isActive: boolean;
        skipConsent: boolean;
        allowedScopes: string[];
        redirectUris: string[];
    }

    const app = ref<Application | null>(null);
    const loading = ref(false);
    const saving = ref(false);
    const saveMsg = ref<string | null>(null);
    const saveError = ref<string | null>(null);

    // Local editable copy
    const form = ref({
        name: "",
        description: "",
        url: "",
        icon: "",
        redirectUrisText: "",
        allowedScopes: [] as string[],
        isActive: true,
        skipConsent: false,
    });

    async function fetchApp() {
        loading.value = true;
        saveMsg.value = null;
        saveError.value = null;
        try {
            const res = await fetch(`/api/admin/applications/${props.appId}`, {
                credentials: "include",
            });
            const data = (await res.json()) as { application: Application; };
            app.value = data.application;
            form.value = {
                name: data.application.name,
                description: data.application.description ?? "",
                url: data.application.url ?? "",
                icon: data.application.icon ?? "",
                redirectUrisText: data.application.redirectUris.join("\n"),
                allowedScopes: [...data.application.allowedScopes],
                isActive: data.application.isActive,
                skipConsent: data.application.skipConsent,
            };
        } finally {
            loading.value = false;
        }
    }

    function toggleScope(scope: string) {
        const idx = form.value.allowedScopes.indexOf(scope);
        if (idx === -1) form.value.allowedScopes.push(scope);
        else form.value.allowedScopes.splice(idx, 1);
    }

    async function save() {
        saving.value = true;
        saveMsg.value = null;
        saveError.value = null;
        try {
            const redirectUris = form.value.redirectUrisText
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean);

            const res = await fetch(`/api/admin/applications/${props.appId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                    name: form.value.name,
                    description: form.value.description || undefined,
                    url: form.value.url || undefined,
                    icon: form.value.icon || undefined,
                    isActive: form.value.isActive,
                    skipConsent: form.value.skipConsent,
                    allowedScopes: form.value.allowedScopes,
                    redirectUris,
                }),
            });
            if (!res.ok) {
                const d = (await res.json().catch(() => ({}))) as { message?: string; };
                saveError.value = d.message ?? t("errors.SRV_001");
            } else {
                saveMsg.value = t("common.save") + " ✓";
                emit("updated");
            }
        } finally {
            saving.value = false;
        }
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
                activeTab.value = "general";
                void fetchApp();
            }
        },
        { immediate: true },
    );

    const appName = computed(() => app.value?.name ?? "…");
    const appSlug = computed(() => app.value?.slug ?? "");
    const appIcon = computed(() => app.value?.icon ?? null);

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
                        <img v-if="appIcon" :src="appIcon" :alt="appName"
                            class="w-6 h-6 rounded shrink-0 object-cover" />
                        <div v-else
                            class="w-6 h-6 rounded flex items-center justify-center text-xs font-bold font-mono shrink-0"
                            style="background: rgba(34,211,238,0.1); color: var(--accent-cyan)">
                            {{ initials(appName) }}
                        </div>
                        <span class="text-sm font-semibold truncate" style="max-width: 96px">{{ appName }}</span>
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
                        <img v-if="appIcon" :src="appIcon" :alt="appName"
                            class="w-8 h-8 rounded-lg mb-2 object-cover" />
                        <div v-else
                            class="w-8 h-8 rounded-lg mb-2 flex items-center justify-center text-xs font-bold font-mono"
                            style="background: rgba(34,211,238,0.1); color: var(--accent-cyan)">
                            {{ initials(appName) }}
                        </div>
                        <p class="font-semibold text-sm leading-tight truncate">{{ appName }}</p>
                        <p class="text-xs font-mono truncate mt-0.5" style="color: var(--text-muted)">{{ appSlug }}</p>
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

                    <div v-if="loading" class="text-center py-16" style="color: var(--text-muted)">
                        {{ t("common.loading") }}
                    </div>

                    <template v-else-if="app">

                        <!-- ── General ─────────────────────────────────────────── -->
                        <template v-if="activeTab === 'general'">
                            <h1 class="text-xl font-semibold gradient-text mb-6">{{ t("admin.generalInfo") }}</h1>
                            <div class="space-y-5">
                                <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
                                    <div>
                                        <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                            style="color: var(--text-muted); letter-spacing: 0.12em">{{
                                            t("admin.appName") }}</label>
                                        <input v-model="form.name" type="text" class="input" required />
                                    </div>
                                    <div>
                                        <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                            style="color: var(--text-muted); letter-spacing: 0.12em">{{
                                            t("admin.appSlug") }}</label>
                                        <input :value="appSlug" type="text" class="input font-mono" style="opacity: 0.5"
                                            disabled />
                                    </div>
                                </div>
                                <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
                                    <div>
                                        <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                            style="color: var(--text-muted); letter-spacing: 0.12em">{{
                                            t("admin.appUrl") }}</label>
                                        <input v-model="form.url" type="url" class="input"
                                            :placeholder="t('common.optional')" />
                                    </div>
                                    <div>
                                        <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                            style="color: var(--text-muted); letter-spacing: 0.12em">{{
                                            t("admin.appIcon") }}</label>
                                        <input v-model="form.icon" type="url" class="input"
                                            :placeholder="t('common.optional')" />
                                    </div>
                                </div>
                                <div>
                                    <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                        style="color: var(--text-muted); letter-spacing: 0.12em">{{
                                        t("admin.appDescription") }}</label>
                                    <textarea v-model="form.description" class="input resize-none" rows="3" />
                                </div>
                            </div>
                        </template>

                        <!-- ── Callbacks ──────────────────────────────────────────── -->
                        <template v-else-if="activeTab === 'callbacks'">
                            <h1 class="text-xl font-semibold gradient-text mb-6">{{ t("admin.redirectUrls") }}</h1>
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--text-muted); letter-spacing: 0.12em">{{ t("admin.redirectUrls")
                                    }}</label>
                                <textarea v-model="form.redirectUrisText" class="input resize-none font-mono text-xs"
                                    rows="10" :placeholder="t('admin.redirectUrlsHint')" />
                                <p class="text-xs mt-2" style="color: var(--text-muted)">
                                    {{ t("admin.redirectUrlsHint") }}
                                </p>
                            </div>
                        </template>

                        <!-- ── Scopes ──────────────────────────────────────────────── -->
                        <template v-else-if="activeTab === 'scopes'">
                            <h1 class="text-xl font-semibold gradient-text mb-6">{{ t("admin.allowedScopes") }}</h1>
                            <div class="space-y-3">
                                <p class="text-sm" style="color: var(--text-muted)">
                                    Sélectionnez les scopes OAuth que cette application est autorisée à demander.
                                </p>
                                <div class="flex flex-wrap gap-2 mt-4">
                                    <button v-for="scope in SCOPES" :key="scope" type="button"
                                        class="flex items-center gap-1.5 badge cursor-pointer select-none transition-colors"
                                        :class="form.allowedScopes.includes(scope) ? 'badge-success' : 'badge-inactive'"
                                        @click="toggleScope(scope)">
                                        <Check v-if="form.allowedScopes.includes(scope)" class="w-3 h-3" />
                                        {{ scope }}
                                    </button>
                                </div>
                            </div>
                        </template>

                        <!-- ── Options ─────────────────────────────────────────────── -->
                        <template v-else-if="activeTab === 'options'">
                            <h1 class="text-xl font-semibold gradient-text mb-6">Options</h1>
                            <div class="space-y-6">
                                <label class="flex items-start gap-4 cursor-pointer select-none">
                                    <div class="mt-0.5">
                                        <input v-model="form.isActive" type="checkbox" class="sr-only" />
                                        <div class="w-9 h-5 rounded-full transition-colors"
                                            :style="form.isActive ? 'background: var(--accent-cyan)' : 'background: var(--border)'">
                                            <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                                :style="form.isActive
                                                    ? 'transform: translateX(1.1rem)'
                                                    : 'transform: translateX(0.125rem)'" />
                                        </div>
                                    </div>
                                    <div>
                                        <p class="text-sm font-medium">{{ t("common.active") }}</p>
                                        <p class="text-xs mt-0.5" style="color: var(--text-muted)">
                                            Lorsqu'inactif, les utilisateurs ne peuvent plus s'authentifier via cette
                                            application.
                                        </p>
                                    </div>
                                </label>

                                <label class="flex items-start gap-4 cursor-pointer select-none">
                                    <div class="mt-0.5">
                                        <input v-model="form.skipConsent" type="checkbox" class="sr-only" />
                                        <div class="w-9 h-5 rounded-full transition-colors"
                                            :style="form.skipConsent ? 'background: var(--accent-cyan)' : 'background: var(--border)'">
                                            <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                                :style="form.skipConsent
                                                    ? 'transform: translateX(1.1rem)'
                                                    : 'transform: translateX(0.125rem)'" />
                                        </div>
                                    </div>
                                    <div>
                                        <p class="text-sm font-medium">{{ t("admin.skipConsent") }}</p>
                                        <p class="text-xs mt-0.5" style="color: var(--text-muted)">
                                            L'utilisateur ne verra pas l'écran de consentement lors de chaque connexion.
                                        </p>
                                    </div>
                                </label>
                            </div>
                        </template>

                        <!-- ── Save bar ───────────────────────────────────────────── -->
                        <div class="flex items-center gap-3 mt-8">
                            <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
                                {{ saving ? t("common.saving") : t("common.save") }}
                            </button>
                            <p v-if="saveMsg" class="text-sm" style="color: var(--accent-cyan)">{{ saveMsg }}</p>
                            <p v-if="saveError" class="text-sm" style="color: #f87171">{{ saveError }}</p>
                        </div>

                    </template>
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
