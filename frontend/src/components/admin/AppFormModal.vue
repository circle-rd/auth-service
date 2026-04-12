<script setup lang="ts">
    import { ref, reactive, watch, onUnmounted } from "vue";
    import { useI18n } from "vue-i18n";
    import { X, Copy, Check, RefreshCw } from "lucide-vue-next";

    const props = defineProps<{
        open: boolean;
        mode?: "create" | "edit";
        /** When true, renders inline (no overlay/Teleport). Used inside AppEditModal. */
        inline?: boolean;
        /** Required in edit mode */
        appId?: string;
    }>();

    const emit = defineEmits<{
        close: [];
        created: [];
        updated: [];
    }>();

    const { t } = useI18n();

    const mode = props.mode ?? "create";

    const SCOPES = ["openid", "profile", "email", "offline_access", "roles", "permissions", "features"];

    // ── Create mode state ─────────────────────────────────────────────────────

    const createForm = reactive({
        name: "",
        slug: "",
        description: "",
        url: "",
        icon: "",
        isActive: true,
        isPublic: false,
        skipConsent: false,
        isMfaRequired: false,
        allowRegister: true,
        allowedScopes: ["openid", "profile", "email"] as string[],
        redirectUris: [] as string[],
    });
    const redirectUrisText = ref("");
    const createError = ref<string | null>(null);
    const creating = ref(false);
    const credentials = ref<{ clientId: string; clientSecret?: string; isPublic: boolean } | null>(null);
    const copied = ref<"id" | "secret" | null>(null);

    function resetCreate() {
        createForm.name = "";
        createForm.slug = "";
        createForm.description = "";
        createForm.url = "";
        createForm.icon = "";
        createForm.isActive = true;
        createForm.isPublic = false;
        createForm.skipConsent = false;
        createForm.isMfaRequired = false;
        createForm.allowRegister = true;
        createForm.allowedScopes = ["openid", "profile", "email"];
        createForm.redirectUris = [];
        redirectUrisText.value = "";
        createError.value = null;
        credentials.value = null;
    }

    function toggleScopeCreate(scope: string) {
        const idx = createForm.allowedScopes.indexOf(scope);
        if (idx >= 0) createForm.allowedScopes.splice(idx, 1);
        else createForm.allowedScopes.push(scope);
    }

    async function submitCreate() {
        createError.value = null;
        creating.value = true;
        createForm.redirectUris = redirectUrisText.value
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        try {
            const res = await fetch("/api/admin/applications", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ ...createForm }),
            });
            const data = (await res.json()) as {
                clientId?: string;
                clientSecret?: string;
                error?: { message?: string };
            };
            if (!res.ok) {
                createError.value = data.error?.message ?? t("errors.SRV_001");
            } else {
                credentials.value = {
                    clientId: data.clientId!,
                    clientSecret: data.clientSecret,
                    isPublic: !data.clientSecret,
                };
                emit("created");
            }
        } finally {
            creating.value = false;
        }
    }

    async function copyToClipboard(text: string, which: "id" | "secret") {
        await navigator.clipboard.writeText(text);
        copied.value = which;
        setTimeout(() => { copied.value = null; }, 1500);
    }

    function closeCreate() {
        resetCreate();
        emit("close");
    }

    // ── Edit mode state ───────────────────────────────────────────────────────

    interface Application {
        id: string;
        name: string;
        slug: string;
        description?: string | null;
        url?: string | null;
        icon?: string | null;
        isActive: boolean;
        isPublic: boolean;
        skipConsent: boolean;
        isMfaRequired: boolean;
        allowRegister: boolean;
        allowedScopes: string[];
        redirectUris: string[];
    }

    const app = ref<Application | null>(null);
    const editRedirectUrisText = ref("");
    const saving = ref(false);
    const infoMsg = ref<string | null>(null);
    const infoError = ref<string | null>(null);
    const rotatingSecret = ref(false);
    const newSecret = ref<string | null>(null);
    const copiedSecret = ref(false);

    async function fetchApp() {
        if (!props.appId) return;
        app.value = null;
        const res = await fetch(`/api/admin/applications/${props.appId}`, {
            credentials: "include",
        });
        const data = (await res.json()) as { application: Application };
        app.value = data.application;
        editRedirectUrisText.value = data.application.redirectUris.join("\n");
    }

    function toggleScopeEdit(scope: string) {
        if (!app.value) return;
        const idx = app.value.allowedScopes.indexOf(scope);
        if (idx === -1) app.value.allowedScopes.push(scope);
        else app.value.allowedScopes.splice(idx, 1);
    }

    async function save() {
        if (!app.value) return;
        saving.value = true;
        infoMsg.value = null;
        infoError.value = null;
        try {
            const redirectUris = editRedirectUrisText.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean);
            const res = await fetch(`/api/admin/applications/${props.appId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                    name: app.value.name,
                    description: app.value.description,
                    url: app.value.url,
                    icon: app.value.icon,
                    isActive: app.value.isActive,
                    skipConsent: app.value.skipConsent,
                    isMfaRequired: app.value.isMfaRequired,
                    allowRegister: app.value.allowRegister,
                    allowedScopes: app.value.allowedScopes,
                    redirectUris,
                }),
            });
            if (!res.ok) {
                const d = (await res.json().catch(() => ({}))) as { message?: string };
                infoError.value = d.message ?? t("errors.SRV_001");
            } else {
                infoMsg.value = t("common.save") + " ✓";
                setTimeout(() => { infoMsg.value = null; }, 3000);
                emit("updated");
            }
        } finally {
            saving.value = false;
        }
    }

    async function rotateSecret() {
        rotatingSecret.value = true;
        newSecret.value = null;
        try {
            const res = await fetch(`/api/admin/applications/${props.appId}/rotate-secret`, {
                method: "POST",
                credentials: "include",
            });
            const data = (await res.json()) as { clientSecret: string };
            newSecret.value = data.clientSecret;
        } finally {
            rotatingSecret.value = false;
        }
    }

    async function copySecret() {
        if (!newSecret.value) return;
        await navigator.clipboard.writeText(newSecret.value);
        copiedSecret.value = true;
        setTimeout(() => { copiedSecret.value = false; }, 1500);
    }

    // ── Lifecycle / watchers ──────────────────────────────────────────────────

    function onEscape(e: KeyboardEvent) {
        if (e.key === "Escape") {
            if (mode === "create") closeCreate();
            else emit("close");
        }
    }

    if (mode === "create" && !props.inline) {
        watch(
            () => props.open,
            (open) => {
                if (open) {
                    resetCreate();
                    document.addEventListener("keydown", onEscape);
                } else {
                    document.removeEventListener("keydown", onEscape);
                }
            },
        );
        onUnmounted(() => document.removeEventListener("keydown", onEscape));
    }

    if (mode === "edit") {
        watch(() => props.appId, fetchApp, { immediate: true });
    }
</script>

<template>
    <!-- ════════════════════════════════════════════════════════════════════════
         CREATE MODE
         ════════════════════════════════════════════════════════════════════════ -->
    <template v-if="mode === 'create'">
        <Teleport to="body">
            <Transition name="modal-fade">
                <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4"
                    style="background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(4px)" @click.self="closeCreate">
                    <div class="card w-full max-w-2xl max-h-[92vh] flex flex-col" style="padding: 0; overflow: hidden">
                        <!-- Header -->
                        <div class="flex items-center justify-between shrink-0 px-6 py-4"
                            style="border-bottom: 1px solid var(--color-border)">
                            <h2 class="font-semibold text-base">{{ t("admin.createApp") }}</h2>
                            <button class="btn btn-ghost p-1.5" @click="closeCreate">
                                <X class="w-4 h-4" />
                            </button>
                        </div>

                        <!-- Credentials screen (shown after creation) -->
                        <div v-if="credentials" class="flex-1 overflow-y-auto px-6 py-6 space-y-5">
                            <div class="rounded-xl px-4 py-3 text-sm font-medium" style="
                                background: var(--color-success-light);
                                border: 1px solid var(--color-success-border);
                                color: var(--color-success);
                            ">
                                {{ credentials.isPublic ? t("admin.appCreatedPublicClient") : t("admin.appCreatedCredentials") }}
                            </div>
                            <div class="space-y-4">
                                <div v-for="item in (credentials.isPublic
                                    ? [{ label: t('admin.clientId'), val: credentials.clientId, key: 'id' as const }]
                                    : [
                                        { label: t('admin.clientId'), val: credentials.clientId, key: 'id' as const },
                                        { label: t('admin.clientSecret'), val: credentials.clientSecret!, key: 'secret' as const },
                                      ]
                                )" :key="item.key">
                                    <p class="text-xs font-mono uppercase tracking-widest mb-2"
                                        style="color: var(--color-text-muted)">
                                        {{ item.label }}
                                    </p>
                                    <div class="flex items-center gap-2">
                                        <code class="flex-1 font-mono text-sm px-3 py-2.5 rounded-lg break-all"
                                            :style="item.key === 'secret'
                                                ? 'background: var(--color-bg); color: #fbbf24'
                                                : 'background: var(--color-bg)'">
                                            {{ item.val }}
                                        </code>
                                        <button class="btn btn-ghost p-2 shrink-0" :title="t('common.copy')"
                                            @click="copyToClipboard(item.val, item.key)">
                                            <Check v-if="copied === item.key" class="w-4 h-4"
                                                style="color: var(--color-success)" />
                                            <Copy v-else class="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div class="rounded-lg px-4 py-3 text-xs" style="
                                background: var(--color-bg);
                                border: 1px solid var(--color-border);
                                color: var(--color-text-muted);
                            ">
                                {{ t("admin.appCreationBootstrap") }}
                            </div>
                            <div class="flex justify-end pt-2">
                                <button class="btn btn-primary" @click="closeCreate">{{ t("common.done") }}</button>
                            </div>
                        </div>

                        <!-- Create form -->
                        <form v-else class="flex-1 overflow-y-auto px-6 py-5 space-y-6"
                            @submit.prevent="submitCreate">
                            <!-- Name + Slug -->
                            <div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
                                <div>
                                    <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                        style="color: var(--color-text-muted)">
                                        {{ t("admin.appName") }}
                                    </label>
                                    <input v-model="createForm.name" type="text" class="input" required />
                                </div>
                                <div>
                                    <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                        style="color: var(--color-text-muted)">
                                        {{ t("admin.appSlug") }}
                                    </label>
                                    <input v-model="createForm.slug" type="text" class="input font-mono"
                                        placeholder="my-app" pattern="[a-z0-9\-]+" required />
                                    <p class="text-xs mt-1" style="color: var(--color-text-muted)">
                                        {{ t("admin.slugHint") }}
                                    </p>
                                </div>
                            </div>

                            <!-- URL + Icon -->
                            <div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
                                <div>
                                    <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                        style="color: var(--color-text-muted)">
                                        {{ t("admin.appUrl") }}
                                        <span style="opacity: 0.55">({{ t("common.optional") }})</span>
                                    </label>
                                    <input v-model="createForm.url" type="url" class="input"
                                        :placeholder="t('common.optional')" />
                                </div>
                                <div>
                                    <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                        style="color: var(--color-text-muted)">
                                        {{ t("admin.appIcon") }}
                                        <span style="opacity: 0.55">({{ t("common.optional") }})</span>
                                    </label>
                                    <input v-model="createForm.icon" type="url" class="input"
                                        :placeholder="t('common.optional')" />
                                </div>
                            </div>

                            <!-- Description -->
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--color-text-muted)">
                                    {{ t("admin.appDescription") }}
                                    <span style="opacity: 0.55">({{ t("common.optional") }})</span>
                                </label>
                                <textarea v-model="createForm.description" class="input resize-none" rows="2" />
                            </div>

                            <!-- Allowed scopes -->
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--color-text-muted)">
                                    {{ t("admin.allowedScopes") }}
                                </label>
                                <div class="flex flex-wrap gap-2">
                                    <button v-for="scope in SCOPES" :key="scope" type="button"
                                        class="badge cursor-pointer select-none transition-colors"
                                        :class="createForm.allowedScopes.includes(scope) ? 'badge-success' : 'badge-inactive'"
                                        @click="toggleScopeCreate(scope)">
                                        {{ scope }}
                                    </button>
                                </div>
                            </div>

                            <!-- Redirect URIs -->
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--color-text-muted)">
                                    {{ t("admin.redirectUrls") }}
                                </label>
                                <textarea v-model="redirectUrisText" class="input resize-none font-mono text-xs"
                                    rows="3" :placeholder="t('admin.redirectUrlsHint')" />
                            </div>

                            <!-- Toggles -->
                            <div class="flex flex-wrap items-center gap-x-8 gap-y-3">
                                <label class="flex items-center gap-2.5 cursor-pointer select-none">
                                    <input v-model="createForm.isActive" type="checkbox" class="sr-only" />
                                    <div class="w-9 h-5 rounded-full transition-colors"
                                        :style="createForm.isActive ? 'background: var(--color-primary)' : 'background: var(--color-border)'">
                                        <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                            :style="createForm.isActive ? 'transform: translateX(1.1rem)' : 'transform: translateX(0.125rem)'" />
                                    </div>
                                    <span class="text-sm">{{ t("common.active") }}</span>
                                </label>
                                <label class="flex items-center gap-2.5 cursor-pointer select-none">
                                    <input v-model="createForm.isPublic" type="checkbox" class="sr-only" />
                                    <div class="w-9 h-5 rounded-full transition-colors"
                                        :style="createForm.isPublic ? 'background: var(--color-primary)' : 'background: var(--color-border)'">
                                        <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                            :style="createForm.isPublic ? 'transform: translateX(1.1rem)' : 'transform: translateX(0.125rem)'" />
                                    </div>
                                    <span class="text-sm">{{ t("admin.isPublic") }}</span>
                                </label>
                                <label class="flex items-center gap-2.5 cursor-pointer select-none">
                                    <input v-model="createForm.skipConsent" type="checkbox" class="sr-only" />
                                    <div class="w-9 h-5 rounded-full transition-colors"
                                        :style="createForm.skipConsent ? 'background: var(--color-primary)' : 'background: var(--color-border)'">
                                        <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                            :style="createForm.skipConsent ? 'transform: translateX(1.1rem)' : 'transform: translateX(0.125rem)'" />
                                    </div>
                                    <span class="text-sm">{{ t("admin.skipConsent") }}</span>
                                </label>
                                <label class="flex items-center gap-2.5 cursor-pointer select-none">
                                    <input v-model="createForm.isMfaRequired" type="checkbox" class="sr-only" />
                                    <div class="w-9 h-5 rounded-full transition-colors"
                                        :style="createForm.isMfaRequired ? 'background: var(--color-primary)' : 'background: var(--color-border)'">
                                        <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                            :style="createForm.isMfaRequired ? 'transform: translateX(1.1rem)' : 'transform: translateX(0.125rem)'" />
                                    </div>
                                    <span class="text-sm">{{ t("admin.isMfaRequired") }}</span>
                                </label>
                                <label class="flex items-center gap-2.5 cursor-pointer select-none">
                                    <input v-model="createForm.allowRegister" type="checkbox" class="sr-only" />
                                    <div class="w-9 h-5 rounded-full transition-colors"
                                        :style="createForm.allowRegister ? 'background: var(--color-primary)' : 'background: var(--color-border)'">
                                        <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                            :style="createForm.allowRegister ? 'transform: translateX(1.1rem)' : 'transform: translateX(0.125rem)'" />
                                    </div>
                                    <span class="text-sm">{{ t("admin.allowRegister") }}</span>
                                </label>
                            </div>

                            <p v-if="createError" class="text-sm" style="color: #f87171">{{ createError }}</p>

                            <!-- Footer -->
                            <div class="flex items-center justify-end gap-3 pt-2"
                                style="border-top: 1px solid var(--color-border)">
                                <button type="button" class="btn btn-secondary" @click="closeCreate">
                                    {{ t("common.cancel") }}
                                </button>
                                <button type="submit" class="btn btn-primary" :disabled="creating">
                                    {{ creating ? t("common.saving") : t("common.create") }}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </Transition>
        </Teleport>
    </template>

    <!-- ════════════════════════════════════════════════════════════════════════
         EDIT MODE (inline)
         ════════════════════════════════════════════════════════════════════════ -->
    <template v-else>
        <div class="space-y-6">
            <div v-if="!app" class="text-sm py-10 text-center" style="color: var(--color-text-muted)">
                {{ t("common.loading") }}
            </div>

            <template v-else>
                <!-- Main info form -->
                <form class="card space-y-6" @submit.prevent="save">
                    <!-- Row: Name + Slug -->
                    <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
                        <div>
                            <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                style="color: var(--color-text-muted); letter-spacing: 0.12em">
                                {{ t("admin.appName") }}
                            </label>
                            <input v-model="app.name" type="text" class="input" required />
                        </div>
                        <div>
                            <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                style="color: var(--color-text-muted); letter-spacing: 0.12em">
                                {{ t("admin.appSlug") }}
                            </label>
                            <input :value="app.slug" type="text" class="input font-mono" style="opacity: 0.5"
                                disabled />
                        </div>
                    </div>

                    <!-- Row: URL + Icon -->
                    <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
                        <div>
                            <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                style="color: var(--color-text-muted); letter-spacing: 0.12em">
                                {{ t("admin.appUrl") }}
                            </label>
                            <input v-model="(app.url as string)" type="url" class="input"
                                :placeholder="t('common.optional')" />
                        </div>
                        <div>
                            <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                style="color: var(--color-text-muted); letter-spacing: 0.12em">
                                {{ t("admin.appIcon") }}
                            </label>
                            <input v-model="(app.icon as string)" type="url" class="input"
                                :placeholder="t('common.optional')" />
                        </div>
                    </div>

                    <!-- Description -->
                    <div>
                        <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                            style="color: var(--color-text-muted); letter-spacing: 0.12em">
                            {{ t("admin.appDescription") }}
                        </label>
                        <textarea v-model="(app.description as string)" class="input resize-none" rows="3" />
                    </div>

                    <!-- Toggles -->
                    <div class="flex flex-wrap items-center gap-x-8 gap-y-3">
                        <label class="flex items-center gap-2.5 cursor-pointer select-none">
                            <input v-model="app.isActive" type="checkbox" class="sr-only" />
                            <div class="w-9 h-5 rounded-full transition-colors"
                                :style="app.isActive ? 'background: var(--color-primary)' : 'background: var(--color-border)'">
                                <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                    :style="app.isActive ? 'transform: translateX(1.1rem)' : 'transform: translateX(0.125rem)'" />
                            </div>
                            <span class="text-sm">{{ t("common.active") }}</span>
                        </label>
                        <label class="flex items-center gap-2.5 cursor-pointer select-none">
                            <input v-model="app.skipConsent" type="checkbox" class="sr-only" />
                            <div class="w-9 h-5 rounded-full transition-colors"
                                :style="app.skipConsent ? 'background: var(--color-primary)' : 'background: var(--color-border)'">
                                <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                    :style="app.skipConsent ? 'transform: translateX(1.1rem)' : 'transform: translateX(0.125rem)'" />
                            </div>
                            <span class="text-sm">{{ t("admin.skipConsent") }}</span>
                        </label>
                        <label class="flex items-center gap-2.5 cursor-pointer select-none">
                            <input v-model="app.isMfaRequired" type="checkbox" class="sr-only" />
                            <div class="w-9 h-5 rounded-full transition-colors"
                                :style="app.isMfaRequired ? 'background: var(--color-primary)' : 'background: var(--color-border)'">
                                <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                    :style="app.isMfaRequired ? 'transform: translateX(1.1rem)' : 'transform: translateX(0.125rem)'" />
                            </div>
                            <span class="text-sm">{{ t("admin.isMfaRequired") }}</span>
                        </label>
                        <label class="flex items-center gap-2.5 cursor-pointer select-none">
                            <input v-model="app.allowRegister" type="checkbox" class="sr-only" />
                            <div class="w-9 h-5 rounded-full transition-colors"
                                :style="app.allowRegister ? 'background: var(--color-primary)' : 'background: var(--color-border)'">
                                <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                    :style="app.allowRegister ? 'transform: translateX(1.1rem)' : 'transform: translateX(0.125rem)'" />
                            </div>
                            <span class="text-sm">{{ t("admin.allowRegister") }}</span>
                        </label>
                        <!-- Public client indicator (read-only — set at creation) -->
                        <span v-if="app.isPublic" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                            style="background: var(--color-primary-light, #eff6ff); color: var(--color-primary); border: 1px solid var(--color-primary-border, #bfdbfe)">
                            {{ t("admin.publicClientBadge") }}
                        </span>
                    </div>

                    <!-- Allowed scopes -->
                    <div>
                        <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                            style="color: var(--color-text-muted); letter-spacing: 0.12em">
                            {{ t("admin.allowedScopes") }}
                        </label>
                        <div class="flex flex-wrap gap-2">
                            <button v-for="scope in SCOPES" :key="scope" type="button"
                                class="badge cursor-pointer select-none transition-colors"
                                :class="app.allowedScopes.includes(scope) ? 'badge-success' : 'badge-inactive'"
                                @click="toggleScopeEdit(scope)">
                                {{ scope }}
                            </button>
                        </div>
                    </div>

                    <!-- Redirect URIs -->
                    <div>
                        <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                            style="color: var(--color-text-muted); letter-spacing: 0.12em">
                            {{ t("admin.redirectUrls") }}
                        </label>
                        <textarea v-model="editRedirectUrisText" class="input resize-none font-mono text-xs" rows="4"
                            :placeholder="t('admin.redirectUrlsHint')" />
                    </div>

                    <p v-if="infoError" class="text-sm" style="color: #f87171">{{ infoError }}</p>
                    <p v-if="infoMsg" class="text-sm" style="color: var(--color-primary)">{{ infoMsg }}</p>

                    <div>
                        <button type="submit" class="btn btn-primary" :disabled="saving">
                            {{ saving ? t("common.saving") : t("common.save") }}
                        </button>
                    </div>
                </form>

                <!-- Client secret rotation (hidden for public clients) -->
                <div v-if="!app.isPublic" class="card space-y-4">
                    <div>
                        <h2 class="text-sm font-semibold">{{ t("admin.clientSecret") }}</h2>
                        <p class="text-xs mt-0.5" style="color: var(--color-text-muted)">
                            {{ t("admin.rotateSecretHint") }}
                        </p>
                    </div>

                    <div v-if="newSecret" class="space-y-2">
                        <p class="text-xs font-medium" style="color: #fbbf24">
                            {{ t("admin.newSecretWarning") }}
                        </p>
                        <div class="flex items-start gap-2">
                            <code class="flex-1 font-mono text-xs px-3 py-2.5 rounded-lg break-all"
                                style="background: var(--color-bg)">
                                {{ newSecret }}
                            </code>
                            <button class="btn btn-ghost p-2 shrink-0" @click="copySecret">
                                <Check v-if="copiedSecret" class="w-4 h-4" style="color: var(--color-success)" />
                                <Copy v-else class="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    <div>
                        <button class="btn btn-secondary text-sm" :disabled="rotatingSecret" @click="rotateSecret">
                            <RefreshCw class="w-4 h-4" :class="rotatingSecret ? 'animate-spin' : ''" />
                            {{ rotatingSecret ? t("common.loading") : t("admin.rotateSecret") }}
                        </button>
                    </div>
                </div>
            </template>
        </div>
    </template>
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
