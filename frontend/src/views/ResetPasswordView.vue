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
    error.value = "Passwords do not match";
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
  <div class="min-h-screen flex items-center justify-center px-4 pt-16">
    <div class="w-full max-w-sm">
      <div class="mb-8 text-center">
        <h1 class="text-2xl font-bold gradient-text mb-2">{{ t("auth.resetPassword") }}</h1>
      </div>

      <div class="card">
        <div v-if="success" class="text-center py-4">
          <p class="text-emerald-400">Password updated! Redirecting...</p>
        </div>
        <form v-else @submit.prevent="handleSubmit" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1.5">{{ t("profile.newPassword") }}</label>
            <input
              v-model="newPassword"
              type="password"
              autocomplete="new-password"
              class="input"
              required
              minlength="8"
            />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1.5">{{ t("profile.confirmPassword") }}</label>
            <input
              v-model="confirmPassword"
              type="password"
              autocomplete="new-password"
              class="input"
              required
              minlength="8"
            />
          </div>
          <p v-if="error" class="text-sm text-red-400">{{ error }}</p>
          <button type="submit" class="btn btn-primary w-full" :disabled="loading">
            {{ loading ? t("common.loading") : t("auth.resetPassword") }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
