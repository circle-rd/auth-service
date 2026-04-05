<script setup lang="ts">
  import { ref } from "vue";
  import { useRouter, useRoute } from "vue-router";
  import { useI18n } from "vue-i18n";

  const { t } = useI18n();
  const router = useRouter();
  const route = useRoute();

  const newPassword = ref("");
  const confirmPassword = ref("");
  const error = ref<string | null>(null);
  const loading = ref(false);
  const success = ref(false);

  async function handleSubmit() {
    error.value = null;
    if (newPassword.value !== confirmPassword.value) {
      error.value = t("profile.passwordMismatch");
      return;
    }
    loading.value = true;
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newPassword: newPassword.value,
          token: route.query.token as string,
        }),
      });
      if (!res.ok) {
        error.value = t("errors.AUTH_008");
      } else {
        success.value = true;
        setTimeout(() => router.push("/login"), 2000);
      }
    } finally {
      loading.value = false;
    }
  }
</script>

<template>
  <div class="auth-page">
    <div class="auth-container">

      <!-- Header -->
      <div class="auth-header">
        <h1 class="auth-title">{{ t("auth.resetPassword") }}</h1>
      </div>

      <!-- Card -->
      <div class="card auth-card">
        <div v-if="success" class="success-state">
          <p class="success-text">{{ t("auth.passwordResetSuccess") }}</p>
        </div>
        <form v-else @submit.prevent="handleSubmit" class="auth-form">
          <div class="form-group">
            <label class="form-label">{{ t("profile.newPassword") }}</label>
            <input v-model="newPassword" type="password" autocomplete="new-password" class="input" required
              minlength="8" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("profile.confirmPassword") }}</label>
            <input v-model="confirmPassword" type="password" autocomplete="new-password" class="input" required
              minlength="8" />
          </div>
          <p v-if="error" class="auth-error">{{ error }}</p>
          <button type="submit" class="btn btn-primary w-full" :disabled="loading">
            {{ loading ? t("common.loading") : t("auth.resetPassword") }}
          </button>
        </form>
      </div>

    </div>
  </div>
</template>

<style scoped>
  .auth-page {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 5rem 1rem 2rem;
    background: var(--color-bg);
  }

  .auth-container {
    width: 100%;
    max-width: 24rem;
  }

  .auth-header {
    margin-bottom: 2rem;
    text-align: center;
  }

  .auth-title {
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--color-text);
    margin: 0 0 0.5rem;
  }

  .auth-card {
    padding: 2rem;
  }

  .auth-form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .auth-error {
    font-size: 0.875rem;
    color: var(--color-danger);
    margin: 0;
  }

  .success-state {
    text-align: center;
    padding: 1rem 0;
  }

  .success-text {
    font-size: 0.875rem;
    color: var(--color-success);
    margin: 0;
  }
</style>
