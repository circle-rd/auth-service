<script setup lang="ts">
  import { ref } from "vue";
  import { useI18n } from "vue-i18n";
  import { User, Lock } from "lucide-vue-next";
  import { useAuthStore } from "../stores/auth.js";

  const { t } = useI18n();
  const authStore = useAuthStore();

  const u = authStore.user as Record<string, unknown> | null;
  const name = ref((u?.name as string) ?? "");
  const image = ref((u?.image as string) ?? "");
  const phone = ref((u?.phone as string) ?? "");
  const company = ref((u?.company as string) ?? "");
  const position = ref((u?.position as string) ?? "");
  const address = ref((u?.address as string) ?? "");

  const currentPassword = ref("");
  const newPassword = ref("");
  const confirmPassword = ref("");
  const profileMsg = ref<string | null>(null);
  const passwordMsg = ref<string | null>(null);
  const profileError = ref<string | null>(null);
  const passwordError = ref<string | null>(null);
  const saving = ref(false);

  const avatarPreview = ref((u?.image as string) ?? "");
  const userInitial = (authStore.user?.name ?? "?").charAt(0).toUpperCase();

  function onAvatarInput() { avatarPreview.value = image.value; }

  async function updateProfile() {
    profileError.value = null;
    profileMsg.value = null;
    saving.value = true;
    try {
      const res = await fetch("/api/auth/update-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: name.value,
          image: image.value || undefined,
          phone: phone.value || undefined,
          company: company.value || undefined,
          position: position.value || undefined,
          address: address.value || undefined,
        }),
      });
      if (!res.ok) {
        profileError.value = t("errors.SRV_001");
      } else {
        profileMsg.value = t("profile.profileUpdated");
        await authStore.fetchSession();
      }
    } finally {
      saving.value = false;
    }
  }

  async function changePassword() {
    passwordError.value = null;
    passwordMsg.value = null;
    if (newPassword.value !== confirmPassword.value) {
      passwordError.value = t("profile.passwordMismatch");
      return;
    }
    saving.value = true;
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          currentPassword: currentPassword.value,
          newPassword: newPassword.value,
        }),
      });
      if (!res.ok) {
        passwordError.value = t("errors.AUTH_003");
      } else {
        passwordMsg.value = t("profile.passwordChanged");
        currentPassword.value = "";
        newPassword.value = "";
        confirmPassword.value = "";
      }
    } finally {
      saving.value = false;
    }
  }
</script>

<template>
  <div class="space-y-7">
    <!-- ── Avatar + identity header ───────────────────────────── -->
    <div class="avatar-header">
      <div>
        <h1 class="text-xl font-bold gradient-text">{{ name || authStore.user?.name }}</h1>
        <p class="text-sm mt-0.5" style="color: var(--text-muted)">{{ authStore.user?.email }}</p>
      </div>
    </div>

    <!-- ── Personal info ───────────────────────────────────────── -->
    <div class="card">
      <div class="flex items-center gap-2 mb-5">
        <User class="w-4 h-4" style="color: var(--accent-cyan)" />
        <h2 class="text-sm font-semibold">{{ t("profile.personalInfo") }}</h2>
      </div>
      <form @submit.prevent="updateProfile" class="space-y-4">
        <!-- Avatar URL + preview -->
        <div class="flex items-center gap-4">
          <!-- Avatar preview circle -->
          <div class="avatar-wrap shrink-0">
            <img v-if="avatarPreview" :src="avatarPreview" :alt="name" class="avatar-img" />
            <span v-else class="avatar-initial">{{ userInitial }}</span>
          </div>
          <!-- Label + input -->
          <div class="flex-1 min-w-0">
            <label class="block text-xs font-medium mb-1.5" style="color: var(--text-muted)">
              {{ t('profile.avatarUrl') }}
              <span class="text-xs ml-1" style="opacity: 0.6">({{ t('common.optional') }})</span>
            </label>
            <input v-model="image" type="url" class="input" :placeholder="t('profile.avatarUrlPlaceholder')"
              @input="onAvatarInput" />
          </div>
        </div>
        <!-- Name + Email -->
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color: var(--text-muted)">{{ t("common.name")
            }}</label>
            <input v-model="name" type="text" class="input" required />
          </div>
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color: var(--text-muted)">{{ t("common.email")
            }}</label>
            <input :value="authStore.user?.email" type="email" class="input opacity-50" disabled />
          </div>
        </div>
        <!-- Phone + Company -->
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color: var(--text-muted)">
              {{ t("profile.phone") }}
              <span class="text-xs ml-1" style="opacity: 0.6">({{ t("common.optional") }})</span>
            </label>
            <input v-model="phone" type="tel" class="input" :placeholder="t('profile.phonePlaceholder')" />
          </div>
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color: var(--text-muted)">
              {{ t("profile.company") }}
              <span class="text-xs ml-1" style="opacity: 0.6">({{ t("common.optional") }})</span>
            </label>
            <input v-model="company" type="text" class="input" :placeholder="t('profile.companyPlaceholder')" />
          </div>
        </div>
        <!-- Position + Address -->
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color: var(--text-muted)">
              {{ t("profile.position") }}
              <span class="text-xs ml-1" style="opacity: 0.6">({{ t("common.optional") }})</span>
            </label>
            <input v-model="position" type="text" class="input" :placeholder="t('profile.positionPlaceholder')" />
          </div>
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color: var(--text-muted)">
              {{ t("profile.address") }}
              <span class="text-xs ml-1" style="opacity: 0.6">({{ t("common.optional") }})</span>
            </label>
            <input v-model="address" type="text" class="input" :placeholder="t('profile.addressPlaceholder')" />
          </div>
        </div>
        <p v-if="profileMsg" class="text-xs text-emerald-400">{{ profileMsg }}</p>
        <p v-if="profileError" class="text-xs text-red-400">{{ profileError }}</p>
        <button type="submit" class="btn btn-primary" :disabled="saving">
          {{ saving ? t("common.saving") : t("profile.updateProfile") }}
        </button>
      </form>
    </div>

    <!-- ── Password ───────────────────────────────────────────── -->
    <div class="card">
      <div class="flex items-center gap-2 mb-5">
        <Lock class="w-4 h-4" style="color: var(--accent-cyan)" />
        <h2 class="text-sm font-semibold">{{ t("profile.security") }}</h2>
      </div>
      <form @submit.prevent="changePassword" class="space-y-4">
        <div>
          <label class="block text-xs font-medium mb-1.5" style="color: var(--text-muted)">{{
            t("profile.currentPassword") }}</label>
          <input v-model="currentPassword" type="password" class="input" required />
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color: var(--text-muted)">{{ t("profile.newPassword")
            }}</label>
            <input v-model="newPassword" type="password" class="input" required minlength="8" />
          </div>
          <div>
            <label class="block text-xs font-medium mb-1.5" style="color: var(--text-muted)">{{
              t("profile.confirmPassword") }}</label>
            <input v-model="confirmPassword" type="password" class="input" required minlength="8" />
          </div>
        </div>
        <p v-if="passwordMsg" class="text-xs text-emerald-400">{{ passwordMsg }}</p>
        <p v-if="passwordError" class="text-xs text-red-400">{{ passwordError }}</p>
        <button type="submit" class="btn btn-primary" :disabled="saving">
          {{ saving ? t("common.saving") : t("profile.changePassword") }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
  .avatar-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding-bottom: 0.5rem;
  }

  .avatar-wrap {
    position: relative;
    width: 3.5rem;
    height: 3.5rem;
    border-radius: 9999px;
    flex-shrink: 0;
    overflow: hidden;
    background: linear-gradient(135deg, rgba(34, 211, 238, 0.12) 0%, rgba(59, 130, 246, 0.12) 100%);
    border: 2px solid rgba(34, 211, 238, 0.25);
    box-shadow: 0 0 16px rgba(34, 211, 238, 0.1);
    cursor: pointer;
  }

  .avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar-initial {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--accent-cyan);
  }

  .avatar-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .avatar-wrap:hover .avatar-overlay {
    opacity: 1;
  }
</style>
