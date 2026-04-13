<script setup lang="ts">
  import { ref } from "vue";
  import { useI18n } from "vue-i18n";
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
  <div class="profile-sections">

    <!-- ── Personal info ───────────────────────────────────────── -->
    <div class="section-group">
      <div class="section-group-header">
        <div>
          <h2 class="section-title">{{ t("profile.personalInfo") }}</h2>
          <p class="section-subtitle">{{ t("profile.personalInfoDesc") }}</p>
        </div>
        <!-- Live avatar preview -->
        <div class="avatar-preview shrink-0">
          <img v-if="avatarPreview" :src="avatarPreview" :alt="name" class="avatar-preview-img" />
          <span v-else class="avatar-preview-initial">{{ userInitial }}</span>
        </div>
      </div>
      <form @submit.prevent="updateProfile" class="section-form">
        <!-- Avatar URL -->
        <div class="field-full">
          <label class="field-label">
            {{ t('profile.avatarUrl') }}
            <span class="field-optional">({{ t('common.optional') }})</span>
          </label>
          <input v-model="image" type="url" class="input" :placeholder="t('profile.avatarUrlPlaceholder')"
            @input="onAvatarInput" />
        </div>
        <!-- Name + Email -->
        <div class="field-grid">
          <div>
            <label class="field-label">{{ t("common.name") }}</label>
            <input v-model="name" type="text" class="input" required />
          </div>
          <div>
            <label class="field-label">{{ t("common.email") }}</label>
            <input :value="authStore.user?.email" type="email" class="input opacity-50" disabled />
          </div>
        </div>
        <!-- Phone + Company -->
        <div class="field-grid">
          <div>
            <label class="field-label">
              {{ t("profile.phone") }}
              <span class="field-optional">({{ t("common.optional") }})</span>
            </label>
            <input v-model="phone" type="tel" class="input" :placeholder="t('profile.phonePlaceholder')" />
          </div>
          <div>
            <label class="field-label">
              {{ t("profile.company") }}
              <span class="field-optional">({{ t("common.optional") }})</span>
            </label>
            <input v-model="company" type="text" class="input" :placeholder="t('profile.companyPlaceholder')" />
          </div>
        </div>
        <!-- Position + Address -->
        <div class="field-grid">
          <div>
            <label class="field-label">
              {{ t("profile.position") }}
              <span class="field-optional">({{ t("common.optional") }})</span>
            </label>
            <input v-model="position" type="text" class="input" :placeholder="t('profile.positionPlaceholder')" />
          </div>
          <div>
            <label class="field-label">
              {{ t("profile.address") }}
              <span class="field-optional">({{ t("common.optional") }})</span>
            </label>
            <input v-model="address" type="text" class="input" :placeholder="t('profile.addressPlaceholder')" />
          </div>
        </div>
        <div class="form-footer">
          <p v-if="profileMsg" class="form-feedback form-feedback--ok">{{ profileMsg }}</p>
          <p v-if="profileError" class="form-feedback form-feedback--err">{{ profileError }}</p>
          <button type="submit" class="btn btn-primary" :disabled="saving">
            {{ saving ? t("common.saving") : t("profile.updateProfile") }}
          </button>
        </div>
      </form>
    </div>

    <!-- ── Security ───────────────────────────────────────────── -->
    <div class="section-group section-group--last">
      <h2 class="section-title">{{ t("profile.security") }}</h2>
      <p class="section-subtitle">{{ t("profile.securityDesc") }}</p>
      <form @submit.prevent="changePassword" class="section-form">
        <div class="field-full">
          <label class="field-label">{{ t("profile.currentPassword") }}</label>
          <input v-model="currentPassword" type="password" class="input" required style="max-width: 24rem" />
        </div>
        <div class="field-grid">
          <div>
            <label class="field-label">{{ t("profile.newPassword") }}</label>
            <input v-model="newPassword" type="password" class="input" required minlength="8" />
          </div>
          <div>
            <label class="field-label">{{ t("profile.confirmPassword") }}</label>
            <input v-model="confirmPassword" type="password" class="input" required minlength="8" />
          </div>
        </div>
        <div class="form-footer">
          <p v-if="passwordMsg" class="form-feedback form-feedback--ok">{{ passwordMsg }}</p>
          <p v-if="passwordError" class="form-feedback form-feedback--err">{{ passwordError }}</p>
          <button type="submit" class="btn btn-primary" :disabled="saving">
            {{ saving ? t("common.saving") : t("profile.changePassword") }}
          </button>
        </div>
      </form>
    </div>

  </div>
</template>

<style scoped>
  /* ── Sections ─────────────────────────────────────────────── */
  .profile-sections {
    display: flex;
    flex-direction: column;
  }

  .section-group {
    padding: 2rem 0;
    border-bottom: 1px solid var(--color-border);
  }

  .section-group--last {
    border-bottom: none;
    padding-bottom: 0;
  }

  .section-group-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.75rem;
  }

  .section-title {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }

  .section-subtitle {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0.25rem 0 0;
  }

  /* ── Avatar preview ───────────────────────────────────────── */
  .avatar-preview {
    width: 3.25rem;
    height: 3.25rem;
    border-radius: 50%;
    overflow: hidden;
    background: var(--color-primary-light);
    border: 2px solid var(--color-primary-border);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .avatar-preview-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar-preview-initial {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--color-primary);
  }

  /* ── Form layout ──────────────────────────────────────────── */
  .section-form {
    display: flex;
    flex-direction: column;
    gap: 1.125rem;
  }

  .field-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.125rem;
  }

  @media (min-width: 640px) {
    .field-grid {
      grid-template-columns: 1fr 1fr;
    }
  }

  .field-full {
    /* full-width field, no special layout needed */
  }

  .field-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-muted);
    margin-bottom: 0.375rem;
  }

  .field-optional {
    font-size: 0.7rem;
    margin-left: 0.25rem;
    opacity: 0.6;
  }

  /* ── Form footer (feedback + save btn) ───────────────────── */
  .form-footer {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    padding-top: 0.5rem;
  }

  .form-feedback {
    font-size: 0.8125rem;
    margin: 0;
  }

  .form-feedback--ok {
    color: var(--color-success);
  }

  .form-feedback--err {
    color: var(--color-danger);
  }
</style>
