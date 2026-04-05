<script setup lang="ts">
  import { ref } from "vue";
  import { useRouter, useRoute, RouterLink } from "vue-router";
  import { useI18n } from "vue-i18n";
  import { LogIn } from "lucide-vue-next";
  import { useAuthStore } from "../stores/auth.js";

  const { t } = useI18n();
  const authStore = useAuthStore();
  const router = useRouter();
  const route = useRoute();

  const email = ref("");
  const password = ref("");
  const error = ref<string | null>(null);
  const loading = ref(false);
  const socialLoading = ref<string | null>(null);

  async function handleSubmit() {
    error.value = null;
    loading.value = true;
    try {
      await authStore.signIn(email.value, password.value);
      const redirectTo = (route.query.redirectTo as string | undefined) ?? "/";
      // If the redirect target is an API path or an absolute URL (OAuth flow),
      // perform a full navigation instead of a Vue Router push which would
      // fail silently for non-SPA routes.
      if (redirectTo.startsWith("/api/") || redirectTo.startsWith("http")) {
        window.location.href = redirectTo;
      } else {
        await router.push(redirectTo);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      if (message === "MFA_REQUIRED") {
        await router.push("/verify-mfa");
      } else {
        error.value = t(`errors.AUTH_003`);
      }
    } finally {
      loading.value = false;
    }
  }

  async function signInWithProvider(provider: "google" | "github") {
    socialLoading.value = provider;
    error.value = null;
    try {
      const callbackURL = (route.query.redirectTo as string | undefined) ?? "/";
      const res = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ provider, callbackURL }),
      });
      const data = (await res.json()) as { url?: string; error?: { message?: string; }; };
      if (!res.ok || !data.url) {
        error.value = data.error?.message ?? t("errors.SRV_001");
        return;
      }
      // Redirect to the provider's OAuth page
      window.location.href = data.url;
    } catch (err) {
      error.value = err instanceof Error ? err.message : t("errors.SRV_001");
    } finally {
      socialLoading.value = null;
    }
  }
</script>

<template>
  <div class="auth-page">
    <div class="auth-container">

      <!-- Header -->
      <div class="auth-header">
        <h1 class="auth-title">{{ t("auth.signInTitle") }}</h1>
        <p class="auth-subtitle">{{ t("auth.signInSubtitle") }}</p>
      </div>

      <!-- Card -->
      <div class="card auth-card">
        <form @submit.prevent="handleSubmit" class="auth-form">

          <!-- Email -->
          <div class="form-group">
            <label class="form-label">{{ t("common.email") }}</label>
            <input v-model="email" type="email" autocomplete="email" :placeholder="t('auth.emailPlaceholder')"
              class="input" required />
          </div>

          <!-- Password -->
          <div class="form-group">
            <div class="form-label-row">
              <label class="form-label">{{ t("common.password") }}</label>
              <RouterLink to="/forgot-password" class="link-subtle text-xs">
                {{ t("auth.forgotPassword") }}
              </RouterLink>
            </div>
            <input v-model="password" type="password" autocomplete="current-password"
              :placeholder="t('auth.passwordPlaceholder')" class="input" required />
          </div>

          <!-- Error -->
          <p v-if="error" class="auth-error">{{ error }}</p>

          <!-- Submit -->
          <button type="submit" class="btn btn-primary w-full" :disabled="loading">
            <LogIn class="w-4 h-4" />
            {{ loading ? t("common.loading") : t("auth.signIn") }}
          </button>

        </form>

        <!-- Social login divider -->
        <div class="auth-divider">
          <span>{{ t("auth.orContinueWith") }}</span>
        </div>

        <!-- Social login buttons -->
        <div class="social-buttons">
          <!-- Google -->
          <button class="btn btn-secondary social-btn" :disabled="!!socialLoading"
            @click="signInWithProvider('google')">
            <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            {{ socialLoading === 'google' ? t("common.loading") : t("auth.continueWithGoogle") }}
          </button>

          <!-- GitHub -->
          <button class="btn btn-secondary social-btn" :disabled="!!socialLoading"
            @click="signInWithProvider('github')">
            <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              <path
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            {{ socialLoading === 'github' ? t("common.loading") : t("auth.continueWithGitHub") }}
          </button>
        </div>
      </div>

      <!-- Footer -->
      <p class="auth-footer">
        {{ t("auth.noAccount") }}
        <RouterLink to="/register" class="link-subtle font-medium">
          {{ t("auth.signUp") }}
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

  .form-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.375rem;
  }

  .form-label-row .form-label {
    margin-bottom: 0;
  }

  .auth-error {
    font-size: 0.875rem;
    color: var(--color-danger);
    margin: 0;
  }

  .auth-footer {
    margin-top: 1.5rem;
    text-align: center;
    font-size: 0.875rem;
    color: var(--color-text-muted);
  }

  .auth-divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1.25rem;
    color: var(--color-text-muted);
    font-size: 0.75rem;
  }

  .auth-divider::before,
  .auth-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }

  .social-buttons {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin-top: 0.75rem;
  }

  .social-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
  }
</style>
