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
  <div class="min-h-screen flex items-center justify-center px-4 pt-16">
    <div class="w-full max-w-sm">

      <!-- Header -->
      <div class="mb-10 text-center">
        <h1 class="mb-2"
          style="font-size: 1.875rem; font-weight: 200; letter-spacing: -0.02em; color: var(--text-primary)">
          {{ t("auth.forgotPassword") }}
        </h1>
        <p style="font-size: 0.875rem; color: var(--text-muted); font-weight: 300">
          Enter your email and we'll send a reset link.
        </p>
      </div>

      <!-- Card -->
      <div class="card" style="padding: 2rem">
        <!-- Confirmed state -->
        <div v-if="submitted" class="text-center py-4 space-y-4">
          <div class="w-12 h-12 rounded-full flex items-center justify-center mx-auto"
            style="background: rgba(34,211,238,0.08); border: 1px solid rgba(34,211,238,0.15)">
            <Mail class="w-5 h-5" style="color: var(--accent-cyan)" />
          </div>
          <p class="text-sm" style="color: var(--text-muted); font-weight: 300">
            If an account exists for <strong style="color: var(--text-primary); font-weight: 500">{{ email }}</strong>,
            a reset link has been sent.
          </p>
        </div>

        <!-- Form -->
        <form v-else @submit.prevent="handleSubmit" class="space-y-7">
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
          <button type="submit" class="btn btn-primary w-full" :disabled="loading">
            {{ loading ? t("common.loading") : t("auth.sendResetLink") }}
          </button>
        </form>
      </div>

      <!-- Footer -->
      <p class="mt-6 text-center text-sm" style="color: var(--text-muted); font-weight: 300">
        <RouterLink to="/login" class="link-subtle text-sm">
          ← {{ t("auth.signIn") }}
        </RouterLink>
      </p>

    </div>
  </div>
</template>
