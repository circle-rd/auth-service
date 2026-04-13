<script setup lang="ts">
  import { ref, reactive, watch, onUnmounted } from "vue";
  import { useI18n } from "vue-i18n";
  import { X } from "lucide-vue-next";

  const props = defineProps<{ open: boolean; }>();
  const emit = defineEmits<{ close: []; created: []; }>();
  const { t } = useI18n();

  const form = reactive({ name: "", slug: "", logo: "" });
  const creating = ref(false);
  const error = ref<string | null>(null);

  function slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .slice(0, 50);
  }

  function onNameInput() {
    form.slug = slugify(form.name);
  }

  function reset() {
    form.name = "";
    form.slug = "";
    form.logo = "";
    error.value = null;
  }

  function close() {
    reset();
    emit("close");
  }

  async function submit() {
    creating.value = true;
    error.value = null;
    try {
      const body: Record<string, string> = { name: form.name, slug: form.slug };
      if (form.logo.trim()) body.logo = form.logo.trim();

      const res = await fetch("/api/admin/organizations", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { organization?: unknown; error?: { message?: string; }; };
      if (!res.ok) {
        error.value = data.error?.message ?? t("errors.SRV_001");
        return;
      }
      close();
      emit("created");
    } catch {
      error.value = t("errors.SRV_001");
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
            <h2 class="text-lg font-semibold">{{ t("admin.newOrganization") }}</h2>
            <button class="btn btn-ghost p-1.5" @click="close">
              <X class="w-4 h-4" />
            </button>
          </div>

          <!-- Form -->
          <form @submit.prevent="submit" class="space-y-4">
            <div>
              <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                style="color: var(--color-text-muted)">
                {{ t("common.name") }}
              </label>
              <input v-model="form.name" type="text" class="input" placeholder="Acme Corp" required
                @input="onNameInput" />
            </div>

            <div>
              <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                style="color: var(--color-text-muted)">
                {{ t("admin.orgSlug") }}
              </label>
              <input v-model="form.slug" type="text" class="input" placeholder="acme-corp" required
                pattern="[a-z0-9-]+" />
              <p class="text-xs mt-1" style="color: var(--color-text-muted)">{{ t("admin.slugHint") }}</p>
            </div>

            <div>
              <label class="block text-xs font-mono uppercase tracking-widest mb-2"
                style="color: var(--color-text-muted)">
                {{ t("admin.appIcon") }}
                <span class="font-normal normal-case ml-1" style="color: var(--color-text-muted)">
                  ({{ t("common.optional") }})
                </span>
              </label>
              <input v-model="form.logo" type="url" class="input" placeholder="https://example.com/logo.png" />
            </div>

            <p v-if="error" class="text-sm" style="color: var(--color-danger)">{{ error }}</p>

            <div class="flex justify-end gap-3 pt-1">
              <button type="button" class="btn btn-secondary" @click="close">
                {{ t("common.cancel") }}
              </button>
              <button type="submit" class="btn btn-primary" :disabled="creating">
                {{ creating ? t("common.saving") : t("admin.newOrganization") }}
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
