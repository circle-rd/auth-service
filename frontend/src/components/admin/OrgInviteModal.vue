<script setup lang="ts">
  import { ref, reactive, watch, onUnmounted } from "vue";
  import { useI18n } from "vue-i18n";
  import { X } from "lucide-vue-next";

  const props = defineProps<{ open: boolean; orgId: string; }>();
  const emit = defineEmits<{ close: []; invited: []; }>();
  const { t } = useI18n();

  const form = reactive({ email: "", role: "member" as "owner" | "admin" | "member", expiresInDays: 7 });
  const inviting = ref(false);
  const error = ref<string | null>(null);

  function reset() {
    form.email = "";
    form.role = "member";
    form.expiresInDays = 7;
    error.value = null;
  }

  function close() {
    reset();
    emit("close");
  }

  async function submit() {
    inviting.value = true;
    error.value = null;
    try {
      const res = await fetch(`/api/admin/organizations/${props.orgId}/invitations`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.email, role: form.role, expiresInDays: form.expiresInDays }),
      });
      const data = (await res.json()) as { invitation?: unknown; error?: { message?: string; }; };
      if (!res.ok) {
        error.value = data.error?.message ?? t("errors.SRV_001");
        return;
      }
      close();
      emit("invited");
    } catch {
      error.value = t("errors.SRV_001");
    } finally {
      inviting.value = false;
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
        <div class="card w-full max-w-sm">
          <div class="flex items-center justify-between mb-5">
            <h2 class="text-lg font-semibold">{{ t("admin.inviteMember") }}</h2>
            <button class="btn btn-ghost p-1.5" @click="close">
              <X class="w-4 h-4" />
            </button>
          </div>

          <form @submit.prevent="submit" class="space-y-4">
            <div>
              <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                style="color: var(--color-text-muted)">
                {{ t("common.email") }}
              </label>
              <input v-model="form.email" type="email" class="input" placeholder="alice@example.com" required />
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                  style="color: var(--color-text-muted)">
                  {{ t("common.role") }}
                </label>
                <select v-model="form.role" class="select">
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                  <option value="owner">owner</option>
                </select>
              </div>

              <div>
                <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                  style="color: var(--color-text-muted)">
                  {{ t("admin.expiresInDays") }}
                </label>
                <input v-model.number="form.expiresInDays" type="number" class="input" min="1" max="30" />
              </div>
            </div>

            <p v-if="error" class="text-sm" style="color: var(--color-danger)">{{ error }}</p>

            <div class="flex justify-end gap-3 pt-1">
              <button type="button" class="btn btn-secondary" @click="close">
                {{ t("common.cancel") }}
              </button>
              <button type="submit" class="btn btn-primary" :disabled="inviting">
                {{ inviting ? t("common.saving") : t("admin.inviteMember") }}
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
