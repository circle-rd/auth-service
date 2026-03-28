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

  async function handleSubmit() {
    error.value = null;
    loading.value = true;
    try {
      await authStore.signIn(email.value, password.value);
      const redirectTo = (route.query.redirectTo as string | undefined) ?? "/";
      await router.push(redirectTo);
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
</script>

<template>
  <div class="min-h-screen flex items-center justify-center px-4 pt-16">
    <div class="w-full max-w-sm">

      <!-- Header -->
      <div class="mb-10 text-center">
        <h1 class="mb-2"
          style="font-size: 1.875rem; font-weight: 200; letter-spacing: -0.02em; color: var(--text-primary)">
          {{ t("auth.signInTitle") }}
        </h1>
        <p style="font-size: 0.875rem; color: var(--text-muted); font-weight: 300">
          {{ t("auth.signInSubtitle") }}
        </p>
      </div>

      <!-- Card -->
      <div class="card" style="padding: 2rem">
        <form @submit.prevent="handleSubmit" class="space-y-7">

          <!-- Email -->
          <div>
            <label class="block mb-2" style="
                font-family: 'JetBrains Mono', monospace;
                font-size: 0.65rem;
                text-transform: uppercase;
                letter-spacing: 0.18em;
                color: var(--text-muted);
              ">
              {{ t("common.email") }}
            </label>
            <input v-model="email" type="email" autocomplete="email" :placeholder="t('auth.emailPlaceholder')"
              class="input" required />
          </div>

          <!-- Password -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <label style="
                  font-family: 'JetBrains Mono', monospace;
                  font-size: 0.65rem;
                  text-transform: uppercase;
                  letter-spacing: 0.18em;
                  color: var(--text-muted);
                ">
                {{ t("common.password") }}
              </label>
              <RouterLink to="/forgot-password" class="link-subtle text-xs">
                {{ t("auth.forgotPassword") }}
              </RouterLink>
            </div>
            <input v-model="password" type="password" autocomplete="current-password"
              :placeholder="t('auth.passwordPlaceholder')" class="input" required />
          </div>

          <!-- Error -->
          <p v-if="error" class="text-sm" style="color: var(--badge-error-color)">{{ error }}</p>

          <!-- Submit -->
          <button type="submit" class="btn btn-primary w-full" :disabled="loading">
            <LogIn class="w-4 h-4" />
            {{ loading ? t("common.loading") : t("auth.signIn") }}
          </button>

        </form>
      </div>

      <!-- Footer -->
      <p class="mt-6 text-center text-sm" style="color: var(--text-muted); font-weight: 300">
        {{ t("auth.noAccount") }}
        <RouterLink to="/register" class="font-medium" style="color: var(--accent-cyan)">
          {{ t("auth.signUp") }}
        </RouterLink>
      </p>

    </div>
  </div>
</template>
