<script setup lang="ts">
    import { ref, reactive, watch, onUnmounted } from "vue";
    import { useI18n } from "vue-i18n";
    import { X, Copy, Check } from "lucide-vue-next";

    const props = defineProps<{ open: boolean; }>();
    const emit = defineEmits<{ close: []; created: []; }>();
    const { t } = useI18n();

    const SCOPES = ["openid", "profile", "email", "offline_access", "roles", "permissions", "features"];

    const form = reactive({
        name: "",
        slug: "",
        description: "",
        isActive: true,
        skipConsent: false,
        allowedScopes: ["openid", "profile", "email"] as string[],
        redirectUris: [] as string[],
    });
    const redirectUrisText = ref("");
    const error = ref<string | null>(null);
    const saving = ref(false);
    const credentials = ref<{ clientId: string; clientSecret: string; } | null>(null);
    const copied = ref<"id" | "secret" | null>(null);

    function toggleScope(scope: string) {
        const idx = form.allowedScopes.indexOf(scope);
        if (idx >= 0) form.allowedScopes.splice(idx, 1);
        else form.allowedScopes.push(scope);
    }

    function reset() {
        form.name = "";
        form.slug = "";
        form.description = "";
        form.isActive = true;
        form.skipConsent = false;
        form.allowedScopes = ["openid", "profile", "email"];
        form.redirectUris = [];
        redirectUrisText.value = "";
        error.value = null;
        credentials.value = null;
    }

    function close() {
        reset();
        emit("close");
    }

    async function submit() {
        error.value = null;
        saving.value = true;
        form.redirectUris = redirectUrisText.value
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        try {
            const res = await fetch("/api/admin/applications", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ ...form }),
            });
            const data = (await res.json()) as {
                clientId?: string;
                clientSecret?: string;
                error?: { message?: string; };
            };
            if (!res.ok) {
                error.value = data.error?.message ?? t("errors.SRV_001");
            } else {
                credentials.value = {
                    clientId: data.clientId!,
                    clientSecret: data.clientSecret!,
                };
                emit("created");
            }
        } finally {
            saving.value = false;
        }
    }

    async function copyToClipboard(text: string, which: "id" | "secret") {
        await navigator.clipboard.writeText(text);
        copied.value = which;
        setTimeout(() => {
            copied.value = null;
        }, 1500);
    }

    function onEscape(e: KeyboardEvent) {
        if (e.key === "Escape") close();
    }

    watch(
        () => props.open,
        (open) => {
            if (open) {
                reset();
                document.addEventListener("keydown", onEscape);
            } else {
                document.removeEventListener("keydown", onEscape);
            }
        },
    );
    onUnmounted(() => document.removeEventListener("keydown", onEscape));
</script>

<template>
    <Teleport to="body">
        <Transition name="modal-fade">
            <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4"
                style="background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(4px)" @click.self="close">
                <div class="card w-full max-w-2xl max-h-[92vh] flex flex-col" style="padding: 0; overflow: hidden">
                    <!-- Header -->
                    <div class="flex items-center justify-between shrink-0 px-6 py-4"
                        style="border-bottom: 1px solid var(--border)">
                        <h2 class="font-semibold text-base">{{ t("admin.createApp") }}</h2>
                        <button class="btn btn-ghost p-1.5" @click="close">
                            <X class="w-4 h-4" />
                        </button>
                    </div>

                    <!-- Credentials: shown once after successful creation -->
                    <div v-if="credentials" class="flex-1 overflow-y-auto px-6 py-6 space-y-5">
                        <div class="rounded-xl px-4 py-3 text-sm font-medium" style="
                background: var(--badge-success-bg);
                border: 1px solid var(--badge-success-border);
                color: var(--badge-success-color);
              ">
                            Application créée — copiez ces identifiants maintenant. Le secret n'est affiché qu'une seule
                            fois.
                        </div>
                        <div class="space-y-4">
                            <div v-for="item in [
                                { label: t('admin.clientId'), val: credentials.clientId, key: 'id' as const },
                                { label: t('admin.clientSecret'), val: credentials.clientSecret, key: 'secret' as const },
                            ]" :key="item.key">
                                <p class="text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--text-muted)">
                                    {{ item.label }}
                                </p>
                                <div class="flex items-center gap-2">
                                    <code class="flex-1 font-mono text-sm px-3 py-2.5 rounded-lg break-all" :style="item.key === 'secret'
                                            ? 'background: var(--bg-secondary); color: #fbbf24'
                                            : 'background: var(--bg-secondary)'
                                        ">
                    {{ item.val }}
                  </code>
                                    <button class="btn btn-ghost p-2 shrink-0" title="Copier"
                                        @click="copyToClipboard(item.val, item.key)">
                                        <Check v-if="copied === item.key" class="w-4 h-4"
                                            style="color: var(--badge-success-color)" />
                                        <Copy v-else class="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div class="flex justify-end pt-2">
                            <button class="btn btn-primary" @click="close">Terminé</button>
                        </div>
                    </div>

                    <!-- Create form -->
                    <form v-else class="flex-1 overflow-y-auto px-6 py-5 space-y-6" @submit.prevent="submit">
                        <!-- Name + Slug -->
                        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--text-muted)">
                                    {{ t("admin.appName") }}
                                </label>
                                <input v-model="form.name" type="text" class="input" required />
                            </div>
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--text-muted)">
                                    {{ t("admin.appSlug") }}
                                </label>
                                <input v-model="form.slug" type="text" class="input font-mono" placeholder="my-app"
                                    pattern="[a-z0-9\-]+" required />
                                <p class="text-xs mt-1" style="color: var(--text-muted)">
                                    Minuscules, chiffres &amp; tirets uniquement
                                </p>
                            </div>
                        </div>

                        <!-- Description -->
                        <div>
                            <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                style="color: var(--text-muted)">
                                {{ t("admin.appDescription") }}
                                <span style="opacity: 0.55">({{ t("common.optional") }})</span>
                            </label>
                            <textarea v-model="form.description" class="input resize-none" rows="2" />
                        </div>

                        <!-- Allowed scopes -->
                        <div>
                            <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                style="color: var(--text-muted)">
                                {{ t("admin.allowedScopes") }}
                            </label>
                            <div class="flex flex-wrap gap-2">
                                <button v-for="scope in SCOPES" :key="scope" type="button"
                                    class="badge cursor-pointer select-none transition-colors"
                                    :class="form.allowedScopes.includes(scope) ? 'badge-success' : 'badge-inactive'"
                                    @click="toggleScope(scope)">
                                    {{ scope }}
                                </button>
                            </div>
                        </div>

                        <!-- Redirect URIs -->
                        <div>
                            <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                style="color: var(--text-muted)">
                                {{ t("admin.redirectUrls") }}
                            </label>
                            <textarea v-model="redirectUrisText" class="input resize-none font-mono text-xs" rows="3"
                                :placeholder="t('admin.redirectUrlsHint')" />
                        </div>

                        <!-- Toggles -->
                        <div class="flex flex-wrap items-center gap-x-8 gap-y-3">
                            <label class="flex items-center gap-2.5 cursor-pointer select-none">
                                <input v-model="form.isActive" type="checkbox" class="sr-only" />
                                <div class="w-9 h-5 rounded-full transition-colors" :style="form.isActive ? 'background: var(--accent-cyan)' : 'background: var(--border)'
                                    ">
                                    <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                        :style="form.isActive
                                                ? 'transform: translateX(1.1rem)'
                                                : 'transform: translateX(0.125rem)'
                                            " />
                                </div>
                                <span class="text-sm">{{ t("common.active") }}</span>
                            </label>
                            <label class="flex items-center gap-2.5 cursor-pointer select-none">
                                <input v-model="form.skipConsent" type="checkbox" class="sr-only" />
                                <div class="w-9 h-5 rounded-full transition-colors" :style="form.skipConsent
                                        ? 'background: var(--accent-cyan)'
                                        : 'background: var(--border)'
                                    ">
                                    <div class="w-4 h-4 bg-white rounded-full shadow transition-transform mt-0.5"
                                        :style="form.skipConsent
                                                ? 'transform: translateX(1.1rem)'
                                                : 'transform: translateX(0.125rem)'
                                            " />
                                </div>
                                <span class="text-sm">{{ t("admin.skipConsent") }}</span>
                            </label>
                        </div>

                        <p v-if="error" class="text-sm" style="color: #f87171">{{ error }}</p>

                        <!-- Footer -->
                        <div class="flex items-center justify-end gap-3 pt-2"
                            style="border-top: 1px solid var(--border)">
                            <button type="button" class="btn btn-secondary" @click="close">
                                {{ t("common.cancel") }}
                            </button>
                            <button type="submit" class="btn btn-primary" :disabled="saving">
                                {{ saving ? t("common.saving") : t("common.create") }}
                            </button>
                        </div>
                    </form>
                </div>
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
