<script setup lang="ts">
  import { ref, reactive, watch, onUnmounted } from "vue";
  import { useI18n } from "vue-i18n";
  import { X } from "lucide-vue-next";

  const props = defineProps<{ open: boolean; orgId: string; }>();
  const emit = defineEmits<{ close: []; added: []; }>();
  const { t } = useI18n();

  const form = reactive({ userId: "", role: "member" as "owner" | "admin" | "member" });
  const adding = ref(false);
  const error = ref<string | null>(null);

  function reset() {
    form.userId = "";
    form.role = "member";
    error.value = null;
  }

  function close() {
    reset();
    emit("close");
  }

  async function submit() {
    adding.value = true;
    error.value = null;
    try {
      const res = await fetch(`/api/admin/organizations/${props.orgId}/members`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: form.userId, role: form.role }),
      });
      const data = (await res.json()) as { member?: unknown; error?: { message?: string; }; };
      if (!res.ok) {
        error.value = data.error?.message ?? t("errors.SRV_001");
        return;
      }
      close();
      emit("added");
    } catch {
      error.value = t("errors.SRV_001");
    } finally {
      adding.value = false;
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
            <h2 class="text-lg font-semibold">{{ t("admin.addMember") }}</h2>
            <button class="btn btn-ghost p-1.5" @click="close">
              <X class="w-4 h-4" />
            </button>
          </div>

          <form @submit.prevent="submit" class="space-y-4">
            <div>
              <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                style="color: var(--color-text-muted)">
                User ID
              </label>
              <input v-model="form.userId" type="text" class="input" placeholder="usr_..." required />
            </div>

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

            <p v-if="error" class="text-sm" style="color: var(--color-danger)">{{ error }}</p>

            <div class="flex justify-end gap-3 pt-1">
              <button type="button" class="btn btn-secondary" @click="close">
                {{ t("common.cancel") }}
              </button>
              <button type="submit" class="btn btn-primary" :disabled="adding">
                {{ adding ? t("common.saving") : t("admin.addMember") }}
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
