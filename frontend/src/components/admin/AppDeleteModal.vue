<script setup lang="ts">
    import { ref } from "vue";
    import { useI18n } from "vue-i18n";
    import { AlertTriangle } from "lucide-vue-next";

    const props = defineProps<{
        appId: string;
        appName: string;
        open: boolean;
    }>();

    const emit = defineEmits<{
        confirm: [];
        cancel: [];
    }>();

    const { t } = useI18n();
    const deleting = ref(false);
    const error = ref<string | null>(null);

    async function handleConfirm() {
        deleting.value = true;
        error.value = null;
        try {
            const res = await fetch(`/api/admin/applications/${props.appId}`, {
                method: "DELETE",
                credentials: "include",
            });
            if (!res.ok && res.status !== 204) {
                const data = (await res.json().catch(() => ({}))) as { message?: string; };
                error.value = data.message ?? t("errors.SRV_001");
                return;
            }
            emit("confirm");
        } finally {
            deleting.value = false;
        }
    }
</script>

<template>
    <Teleport to="body">
        <Transition name="fade">
            <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4"
                style="background: rgba(0,0,0,0.6); backdrop-filter: blur(4px)" @click.self="emit('cancel')">
                <div class="card w-full max-w-md space-y-5" style="border-color: rgba(239,68,68,0.25)" @click.stop>
                    <!-- Header -->
                    <div class="flex items-start gap-3">
                        <div class="shrink-0 w-9 h-9 rounded-full flex items-center justify-center"
                            style="background: rgba(239,68,68,0.12)">
                            <AlertTriangle class="w-4 h-4" style="color: #f87171" />
                        </div>
                        <div>
                            <h2 class="font-semibold text-base">{{ t("admin.deleteApp") }}</h2>
                            <p class="text-sm mt-0.5 font-mono" style="color: var(--text-muted)">{{ appName }}</p>
                        </div>
                    </div>

                    <!-- Warning message -->
                    <div class="rounded-lg px-4 py-3 text-sm leading-relaxed"
                        style="background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.15); color: var(--text-primary)">
                        {{ t("admin.deleteAppWarning") }}
                    </div>

                    <p class="text-sm font-medium">{{ t("admin.deleteAppConfirm") }}</p>

                    <p v-if="error" class="text-sm" style="color: #f87171">{{ error }}</p>

                    <!-- Actions -->
                    <div class="flex items-center gap-3 justify-end">
                        <button class="btn btn-secondary" :disabled="deleting" @click="emit('cancel')">
                            {{ t("common.cancel") }}
                        </button>
                        <button class="btn btn-danger" :disabled="deleting" @click="handleConfirm">
                            {{ deleting ? t("common.loading") : t("common.delete") }}
                        </button>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>

    .fade-enter-active,
    .fade-leave-active {
        transition: opacity 0.15s ease;
    }

    .fade-enter-from,
    .fade-leave-to {
        opacity: 0;
    }
</style>
