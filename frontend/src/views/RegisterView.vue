<script setup lang="ts">
  import { ref } from "vue";
  import { useRouter, RouterLink } from "vue-router";
  import { useI18n } from "vue-i18n";
  import { UserPlus } from "lucide-vue-next";
  import { useAuthStore } from "../stores/auth.js";

  const { t } = useI18n();
  const authStore = useAuthStore();
  const router = useRouter();

  const name = ref("");
  const email = ref("");
  const password = ref("");
  const error = ref<string | null>(null);
  const loading = ref(false);

  async function handleSubmit() {
    error.value = null;
    loading.value = true;
    try {
      await authStore.register(email.value, password.value, name.value);
      await router.push("/profile");
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
  <div class="min-h-screen flex items-center justify-center px-4 pt-16">
    <div class="w-full max-w-sm">

      <!-- Header -->
      <div class="mb-10 text-center">
        <h1 class="mb-2"
          style="font-size: 1.875rem; font-weight: 200; letter-spacing: -0.02em; color: var(--text-primary)">
          {{ t("auth.signUpTitle") }}
        </h1>
        <p style="font-size: 0.875rem; color: var(--text-muted); font-weight: 300">
          {{ t("auth.signUpSubtitle") }}
        </p>
      </div>

      <!-- Card -->
      <div class="card" style="padding: 2rem">
        <form @submit.prevent="handleSubmit" class="space-y-7">

          <!-- Name -->
          <div>
            <label class="block mb-2" style="
                font-family: 'JetBrains Mono', monospace;
                font-size: 0.65rem;
                text-transform: uppercase;
                letter-spacing: 0.18em;
                color: var(--text-muted);
              ">
              {{ t("auth.nameLabel") }}
            </label>
            <input v-model="name" type="text" autocomplete="name" :placeholder="t('auth.namePlaceholder')" class="input"
              required />
          </div>

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
            <label class="block mb-2" style="
                font-family: 'JetBrains Mono', monospace;
                font-size: 0.65rem;
                text-transform: uppercase;
                letter-spacing: 0.18em;
                color: var(--text-muted);
              ">
              {{ t("common.password") }}
            </label>
            <input v-model="password" type="password" autocomplete="new-password"
              :placeholder="t('auth.passwordPlaceholder')" class="input" required minlength="8" />
          </div>

          <p v-if="error" class="text-sm" style="color: var(--badge-error-color)">{{ error }}</p>

          <button type="submit" class="btn btn-primary w-full" :disabled="loading">
            <UserPlus class="w-4 h-4" />
            {{ loading ? t("common.loading") : t("auth.signUp") }}
          </button>

        </form>
      </div>

      <!-- Footer -->
      <p class="mt-6 text-center text-sm" style="color: var(--text-muted); font-weight: 300">
        {{ t("auth.hasAccount") }}
        <RouterLink to="/login" class="font-medium" style="color: var(--accent-cyan)">
          {{ t("auth.signIn") }}
        </RouterLink>
      </p>

    </div>
  </div>
</template>
