<script setup lang="ts">
  import { ref } from "vue";
  import { RouterLink } from "vue-router";
  import { useI18n } from "vue-i18n";
  import { Mail } from "lucide-vue-next";

  const { t } = useI18n();

  const email = ref("");
  const submitted = ref(false);
  const loading = ref(false);

  async function handleSubmit() {
    loading.value = true;
    try {
      await fetch("/api/auth/forget-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.value, redirectTo: "/reset-password" }),
      });
      submitted.value = true;
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
        <h1 class="auth-title">{{ t("auth.forgotPassword") }}</h1>
        <p class="auth-subtitle">{{ t("auth.forgotPasswordHint") }}</p>
      </div>

      <!-- Card -->
      <div class="card auth-card">
        <!-- Confirmed state -->
        <div v-if="submitted" class="submitted-state">
          <div class="submitted-icon">
            <Mail class="w-5 h-5" />
          </div>
          <p class="submitted-text">
            If an account exists for <strong>{{ email }}</strong>,
            a reset link has been sent.
          </p>
        </div>

        <!-- Form -->
        <form v-else @submit.prevent="handleSubmit" class="auth-form">
          <div class="form-group">
            <label class="form-label">{{ t("common.email") }}</label>
            <input v-model="email" type="email" autocomplete="email" :placeholder="t('auth.emailPlaceholder')"
              class="input" required />
          </div>
          <button type="submit" class="btn btn-primary w-full" :disabled="loading">
            {{ loading ? t("common.loading") : t("auth.sendResetLink") }}
          </button>
        </form>
      </div>

      <!-- Footer -->
      <p class="auth-footer">
        <RouterLink to="/login" class="link-subtle text-sm">
          ← {{ t("auth.signIn") }}
        </RouterLink>
      </p>

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

  .auth-subtitle {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .auth-card {
    padding: 2rem;
  }

  .auth-form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .submitted-state {
    text-align: center;
    padding: 1rem 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .submitted-icon {
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-primary-light);
    border: 1px solid var(--color-primary-border);
    color: var(--color-primary);
  }

  .submitted-text {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    line-height: 1.6;
    margin: 0;
  }

  .submitted-text strong {
    color: var(--color-text);
    font-weight: 500;
  }

  .auth-footer {
    margin-top: 1.5rem;
    text-align: center;
    font-size: 0.875rem;
    color: var(--color-text-muted);
  }
</style>
