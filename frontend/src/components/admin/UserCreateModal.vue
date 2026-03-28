<script setup lang="ts">
    import { ref, reactive, watch, onUnmounted } from "vue";
    import { useI18n } from "vue-i18n";
    import { X } from "lucide-vue-next";

    const props = defineProps<{ open: boolean; }>();
    const emit = defineEmits<{ close: []; created: []; }>();
    const { t } = useI18n();

    const form = reactive({ name: "", email: "", password: "", role: "user" });
    const creating = ref(false);
    const createError = ref<string | null>(null);

    function reset() {
        form.name = "";
        form.email = "";
        form.password = "";
        form.role = "user";
        createError.value = null;
    }

    function close() {
        reset();
        emit("close");
    }

    async function submit() {
        creating.value = true;
        createError.value = null;
        try {
            const res = await fetch("/api/admin/users", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(form),
            });
            const data = (await res.json()) as {
                user?: unknown;
                error?: { message?: string; };
            };
            if (!res.ok) {
                createError.value = data.error?.message ?? t("errors.SRV_001");
                return;
            }
            close();
            emit("created");
        } catch {
            createError.value = t("errors.SRV_001");
        } finally {
            creating.value = false;
        }
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
                style="background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(3px)" @click.self="close">
                <div class="card w-full max-w-md">
                    <!-- Header -->
                    <div class="flex items-center justify-between mb-5">
                        <h2 class="text-lg font-semibold">{{ t("admin.createUser") }}</h2>
                        <button class="btn btn-ghost p-1.5" @click="close">
                            <X class="w-4 h-4" />
                        </button>
                    </div>

                    <!-- Form -->
                    <form @submit.prevent="submit" class="space-y-5">
                        <!-- Name + Email -->
                        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--text-muted)">
                                    {{ t("common.name") }}
                                </label>
                                <input v-model="form.name" type="text" class="input"
                                    :placeholder="t('auth.namePlaceholder')" required />
                            </div>
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--text-muted)">
                                    {{ t("common.email") }}
                                </label>
                                <input v-model="form.email" type="email" class="input"
                                    :placeholder="t('auth.emailPlaceholder')" required />
                            </div>
                        </div>

                        <!-- Password + Role -->
                        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--text-muted)">
                                    {{ t("common.password") }}
                                </label>
                                <input v-model="form.password" type="password" class="input"
                                    :placeholder="t('auth.passwordPlaceholder')" required minlength="8" />
                            </div>
                            <div>
                                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                                    style="color: var(--text-muted)">
                                    {{ t("common.role") }}
                                </label>
                                <select v-model="form.role" class="select">
                                    <option value="user">user</option>
                                    <option value="admin">admin</option>
                                    <option value="superadmin">superadmin</option>
                                </select>
                            </div>
                        </div>

                        <p v-if="createError" class="text-sm" style="color: var(--badge-error-color)">
                            {{ createError }}
                        </p>

                        <div class="flex justify-end gap-3 pt-1">
                            <button type="button" class="btn btn-secondary" @click="close">
                                {{ t("common.cancel") }}
                            </button>
                            <button type="submit" class="btn btn-primary" :disabled="creating">
                                {{ creating ? t("common.saving") : t("admin.createUser") }}
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
