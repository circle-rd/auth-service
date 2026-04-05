<script setup lang="ts">
    import { ref, watch } from "vue";
    import { useI18n } from "vue-i18n";
    import { RefreshCw, Copy, Check } from "lucide-vue-next";

    const props = defineProps<{ appId: string; }>();
    const emit = defineEmits<{ updated: []; }>();
    const { t } = useI18n();

    const SCOPES = [
        "openid",
        "profile",
        "email",
        "offline_access",
        "roles",
        "permissions",
        "features",
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
        isMfaRequired: boolean;
        allowedScopes: string[];
        redirectUris: string[];
    }

    const app = ref<Application | null>(null);
    const saving = ref(false);
    const infoMsg = ref<string | null>(null);
    const infoError = ref<string | null>(null);
    const rotatingSecret = ref(false);
    const newSecret = ref<string | null>(null);
    const copiedSecret = ref(false);

    async function fetchApp() {
        app.value = null;
        const res = await fetch(`/api/admin/applications/${props.appId}`, {
            credentials: "include",
        });
        const data = (await res.json()) as { application: Application; };
        app.value = data.application;
    }

    function toggleScope(scope: string) {
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
                    allowedScopes: app.value.allowedScopes,
                    redirectUris: app.value.redirectUris,
                }),
            });
            if (!res.ok) {
                const d = (await res.json().catch(() => ({}))) as { message?: string; };
                infoError.value = d.message ?? t("errors.SRV_001");
            } else {
                infoMsg.value = t("common.save") + " ✓";
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
            const data = (await res.json()) as { clientSecret: string; };
            newSecret.value = data.clientSecret;
        } finally {
            rotatingSecret.value = false;
        }
    }

    async function copySecret() {
        if (!newSecret.value) return;
        await navigator.clipboard.writeText(newSecret.value);
        copiedSecret.value = true;
        setTimeout(() => {
            copiedSecret.value = false;
        }, 1500);
    }

    watch(() => props.appId, fetchApp, { immediate: true });
</script>

<template>
    <div class="space-y-6">
        <div v-if="!app" class="text-sm py-10 text-center" style="color: var(--color-text-muted)">
            {{ t("common.loading") }}
        </div>

        <template v-else>
            <!-- Main info form -->
            <form @submit.prevent="save" class="card space-y-6">
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
                        <input :value="app.slug" type="text" class="input font-mono" style="opacity: 0.5" disabled />
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

                <!-- Toggles: Active + SkipConsent -->
                <div class="flex flex-wrap items-center gap-x-8 gap-y-3">
                    <label class="flex items-center gap-2.5 cursor-pointer select-none">
                        <input v-model="app.isActive" type="checkbox" class="sr-only" />
                        <div class="w-9 h-5 rounded-full transition-colors"
                            :style="app.isActive ? 'background: var(--color-primary)' : 'background: var(--color-border)'">
                            <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5" :style="app.isActive
                                ? 'transform: translateX(1.1rem)'
                                : 'transform: translateX(0.125rem)'
                                " />
                        </div>
                        <span class="text-sm">{{ t("common.active") }}</span>
                    </label>
                    <label class="flex items-center gap-2.5 cursor-pointer select-none">
                        <input v-model="app.skipConsent" type="checkbox" class="sr-only" />
                        <div class="w-9 h-5 rounded-full transition-colors" :style="app.skipConsent ? 'background: var(--color-primary)' : 'background: var(--color-border)'
                            ">
                            <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5" :style="app.skipConsent
                                ? 'transform: translateX(1.1rem)'
                                : 'transform: translateX(0.125rem)'
                                " />
                        </div>
                        <span class="text-sm">{{ t("admin.skipConsent") }}</span>
                    </label>
                    <label class="flex items-center gap-2.5 cursor-pointer select-none">
                        <input v-model="app.isMfaRequired" type="checkbox" class="sr-only" />
                        <div class="w-9 h-5 rounded-full transition-colors" :style="app.isMfaRequired ? 'background: var(--color-primary)' : 'background: var(--color-border)'
                            ">
                            <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5" :style="app.isMfaRequired
                                ? 'transform: translateX(1.1rem)'
                                : 'transform: translateX(0.125rem)'
                                " />
                        </div>
                        <span class="text-sm">{{ t("admin.isMfaRequired") }}</span>
                    </label>
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
                            @click="toggleScope(scope)">
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
                    <textarea :value="app.redirectUris.join('\n')" class="input resize-none font-mono text-xs" rows="4"
                        :placeholder="t('admin.redirectUrlsHint')" @input="
                            app.redirectUris = ($event.target as HTMLTextAreaElement).value
                                .split('\n')
                                .map((s) => s.trim())
                                .filter(Boolean)
                            " />
                </div>

                <p v-if="infoError" class="text-sm" style="color: #f87171">{{ infoError }}</p>
                <p v-if="infoMsg" class="text-sm" style="color: var(--color-primary)">{{ infoMsg }}</p>

                <div>
                    <button type="submit" class="btn btn-primary" :disabled="saving">
                        {{ saving ? t("common.saving") : t("common.save") }}
                    </button>
                </div>
            </form>

            <!-- Client secret rotation -->
            <div class="card space-y-4">
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
