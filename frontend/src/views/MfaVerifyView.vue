<script setup lang="ts">
  import { ref } from "vue";
  import { useRouter } from "vue-router";
  import { useI18n } from "vue-i18n";
  import { ShieldCheck } from "lucide-vue-next";
  import { startAuthentication } from "@simplewebauthn/browser";
  import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

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
      // 1. Get authentication options from server
      const optRes = await fetch("/api/auth/passkey/generate-authenticate-options", {
        method: "POST",
        credentials: "include",
      });
      if (!optRes.ok) {
        error.value = t("errors.AUTH_005");
        return;
      }
      const options = (await optRes.json()) as PublicKeyCredentialRequestOptionsJSON;

      // 2. Browser prompts for passkey — startAuthentication handles proper serialization
      const authResp = await startAuthentication({ optionsJSON: options });

      // 3. Send serialized assertion to server to verify
      const verifyRes = await fetch("/api/auth/passkey/verify-authentication", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(authResp),
      });
      if (!verifyRes.ok) {
        error.value = t("errors.AUTH_005");
      } else {
        await router.push("/profile");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("NotAllowedError") || msg.includes("cancelled")) {
        error.value = t("errors.AUTH_005");
      } else {
        error.value = msg || t("errors.AUTH_005");
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
        <div class="mfa-icon">
          <ShieldCheck class="w-6 h-6" />
        </div>
        <h1 class="auth-title">{{ t("auth.mfaTitle") }}</h1>
        <p class="auth-subtitle">{{ t("auth.mfaSubtitle") }}</p>
      </div>

      <!-- Card -->
      <div class="card auth-card">

        <!-- TOTP mode -->
        <div v-if="!useHardwareKey" class="auth-form">
          <div class="form-group">
            <label class="form-label text-center">{{ t("auth.totpLabel") }}</label>
            <input v-model="code" type="text" inputmode="numeric" autocomplete="one-time-code"
              :placeholder="t('auth.totpPlaceholder')" class="input font-mono text-center"
              style="font-size: 1.25rem; letter-spacing: 0.3em" maxlength="6" required />
          </div>
          <p v-if="error" class="auth-error text-center">{{ error }}</p>
          <button class="btn btn-primary w-full" :disabled="loading" @click="verifyTotp">
            {{ loading ? t("common.loading") : t("auth.verifyCode") }}
          </button>
          <button class="btn btn-ghost w-full" @click="useHardwareKey = true">
            {{ t("auth.useHardwareKey") }}
          </button>
        </div>

        <!-- Hardware key mode -->
        <div v-else class="auth-form">
          <p class="text-sm text-center" style="color: var(--color-text-muted)">
            Touch your hardware key to authenticate.
          </p>
          <p v-if="error" class="auth-error text-center">{{ error }}</p>
          <button class="btn btn-primary w-full" :disabled="loading" @click="verifyPasskey">
            {{ loading ? t("common.loading") : "Authenticate with hardware key" }}
          </button>
          <button class="btn btn-ghost w-full" @click="useHardwareKey = false">
            Use {{ t("auth.totpLabel") }} instead
          </button>
        </div>

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
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .mfa-icon {
    width: 3.5rem;
    height: 3.5rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-primary-light);
    border: 1px solid var(--color-primary-border);
    color: var(--color-primary);
  }

  .auth-title {
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--color-text);
    margin: 0;
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
</style>
