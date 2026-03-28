<script setup lang="ts">
  import { ref } from "vue";
  import { useRouter } from "vue-router";
  import { useI18n } from "vue-i18n";
  import { ShieldCheck } from "lucide-vue-next";

  const { t } = useI18n();
  const router = useRouter();

  const code = ref("");
  const error = ref<string | null>(null);
  const loading = ref(false);
  const useHardwareKey = ref(false);

  async function verifyTotp() {
    error.value = null;
    loading.value = true;
    try {
      const res = await fetch("/api/auth/two-factor/verify-totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code: code.value }),
      });
      if (!res.ok) {
        error.value = t("errors.AUTH_005");
      } else {
        await router.push("/profile");
      }
    } finally {
      loading.value = false;
    }
  }

  async function verifyPasskey() {
    error.value = null;
    loading.value = true;
    try {
      const res = await fetch("/api/auth/passkey/authenticate", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        error.value = t("errors.AUTH_005");
      } else {
        await router.push("/profile");
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
        <div class="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5"
          style="background: rgba(34,211,238,0.08); border: 1px solid rgba(34,211,238,0.2)">
          <ShieldCheck class="w-6 h-6" style="color: var(--accent-cyan)" />
        </div>
        <h1 class="mb-2"
          style="font-size: 1.875rem; font-weight: 200; letter-spacing: -0.02em; color: var(--text-primary)">
          {{ t("auth.mfaTitle") }}
        </h1>
        <p style="font-size: 0.875rem; color: var(--text-muted); font-weight: 300">
          {{ t("auth.mfaSubtitle") }}
        </p>
      </div>

      <!-- Card -->
      <div class="card" style="padding: 2rem">

        <!-- TOTP mode -->
        <div v-if="!useHardwareKey" class="space-y-7">
          <div>
            <label class="block mb-2 text-center" style="
                font-family: 'JetBrains Mono', monospace;
                font-size: 0.65rem;
                text-transform: uppercase;
                letter-spacing: 0.18em;
                color: var(--text-muted);
              ">
              {{ t("auth.totpLabel") }}
            </label>
            <input v-model="code" type="text" inputmode="numeric" autocomplete="one-time-code"
              :placeholder="t('auth.totpPlaceholder')" class="input font-mono tracking-widest text-center text-lg"
              maxlength="6" required />
          </div>
          <p v-if="error" class="text-sm text-center" style="color: var(--badge-error-color)">{{ error }}</p>
          <button class="btn btn-primary w-full" :disabled="loading" @click="verifyTotp">
            {{ loading ? t("common.loading") : t("auth.verifyCode") }}
          </button>
          <button class="btn btn-ghost w-full text-sm" @click="useHardwareKey = true">
            {{ t("auth.useHardwareKey") }}
          </button>
        </div>

        <!-- Hardware key mode -->
        <div v-else class="space-y-7">
          <p class="text-sm text-center" style="color: var(--text-muted); font-weight: 300">
            Touch your hardware key to authenticate.
          </p>
          <p v-if="error" class="text-sm text-center" style="color: var(--badge-error-color)">{{ error }}</p>
          <button class="btn btn-primary w-full" :disabled="loading" @click="verifyPasskey">
            {{ loading ? t("common.loading") : "Authenticate with hardware key" }}
          </button>
          <button class="btn btn-ghost w-full text-sm" @click="useHardwareKey = false">
            {{ t("auth.totpLabel") }} instead
          </button>
        </div>

      </div>
    </div>
  </div>
</template>
