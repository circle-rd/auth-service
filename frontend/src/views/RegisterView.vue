<script setup lang="ts">
  import { ref, computed, watch } from "vue";
  import { useRouter, useRoute, RouterLink } from "vue-router";
  import { useI18n } from "vue-i18n";
  import { UserPlus } from "lucide-vue-next";
  import { useAuthStore } from "../stores/auth.js";
  import { useAppConfig } from "../composables/useAppConfig.js";

  const { t } = useI18n();
  const authStore = useAuthStore();
  const router = useRouter();
  const route = useRoute();

  const name = ref("");
  const email = ref("");
  const password = ref("");
  const error = ref<string | null>(null);
  const loading = ref(false);

  const clientId = computed(() => route.query.client_id as string | undefined);
  const { appConfig } = useAppConfig(clientId);

  const loginPath = computed(() => {
    const qs = new URLSearchParams(route.query as Record<string, string>).toString();
    return qs ? `/login?${qs}` : "/login";
  });

  // Redirect to login if the app has disabled registration.
  // Uses a watcher via useAppConfig; after config loads we react.
  watch(appConfig, (cfg) => {
    if (cfg && !cfg.allowRegister) {
      void router.replace(loginPath.value);
    }
  });

  async function handleSubmit() {
    error.value = null;
    loading.value = true;
    try {
      const rawQuery = route.query as Record<string, string>;
      // Carry the full OAuth signed query string when present so BetterAuth
      // can resume the authorization flow immediately after sign-up.
      const oauthQuery =
        rawQuery.client_id !== undefined && rawQuery.sig !== undefined
          ? new URLSearchParams(rawQuery).toString()
          : undefined;
      const redirectTo = rawQuery.redirectTo ?? "/profile";

      const result = await authStore.register(email.value, password.value, name.value, {
        callbackURL: redirectTo,
        oauthQuery,
      });

      if (result?.url) {
        window.location.href = result.url;
      } else if (oauthQuery) {
        // Session created but no redirect URL returned — re-trigger the OAuth
        // authorization flow by sending the user back to /login with context.
        window.location.href = `/login?${oauthQuery}`;
      } else if (redirectTo.startsWith("/api/") || redirectTo.startsWith("http")) {
        window.location.href = redirectTo;
      } else {
        await router.push(redirectTo);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("already")) {
        error.value = t("errors.AUTH_010");
      } else if (msg.includes("weak") || msg.includes("password")) {
        error.value = t("errors.AUTH_009");
      } else {
        error.value = t("errors.SRV_001");
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
        <div class="auth-icon">
          <UserPlus class="w-5 h-5" />
        </div>
        <h1 class="auth-title">{{ t("auth.signUpTitle") }}</h1>
        <p class="auth-subtitle">{{ t("auth.signUpSubtitle") }}</p>
      </div>

      <!-- Card -->
      <div class="card auth-card">
        <form @submit.prevent="handleSubmit" class="auth-form">

          <!-- Name -->
          <div class="form-group">
            <label class="form-label">{{ t("auth.nameLabel") }}</label>
            <input v-model="name" type="text" autocomplete="name" :placeholder="t('auth.namePlaceholder')" class="input"
              required />
          </div>

          <!-- Email -->
          <div class="form-group">
            <label class="form-label">{{ t("common.email") }}</label>
            <input v-model="email" type="email" autocomplete="email" :placeholder="t('auth.emailPlaceholder')"
              class="input" required />
          </div>

          <!-- Password -->
          <div class="form-group">
            <label class="form-label">{{ t("common.password") }}</label>
            <input v-model="password" type="password" autocomplete="new-password"
              :placeholder="t('auth.passwordPlaceholder')" class="input" required minlength="8" />
          </div>

          <p v-if="error" class="auth-error">{{ error }}</p>

          <button type="submit" class="btn btn-primary w-full" :disabled="loading">
            <UserPlus class="w-4 h-4" />
            {{ loading ? t("common.loading") : t("auth.signUp") }}
          </button>

        </form>
      </div>

      <!-- Footer -->
      <p class="auth-footer">
        {{ t("auth.hasAccount") }}
        <RouterLink :to="loginPath" class="link-subtle font-medium">
          {{ t("auth.signIn") }}
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
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .auth-icon {
    width: 3.5rem;
    height: 3.5rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-primary-light);
    border: 1px solid var(--color-primary-border);
    color: var(--color-primary);
    flex-shrink: 0;
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
</style>
