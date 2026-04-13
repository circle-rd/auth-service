<script setup lang="ts">
  import { ref, nextTick } from "vue";
  import { useRouter } from "vue-router";
  import { useI18n } from "vue-i18n";
  import { ShieldCheck, Key } from "lucide-vue-next";
  import { startAuthentication } from "@simplewebauthn/browser";
  import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

  const { t } = useI18n();
  const router = useRouter();

  // Six individual digit slots (two groups of 3)
  const digits = ref<string[]>(Array(6).fill(""));
  const inputRefs = ref<(HTMLInputElement | null)[]>(Array(6).fill(null));

  const error = ref<string | null>(null);
  const loading = ref(false);
  const useHardwareKey = ref(false);

  function setInputRef(el: HTMLInputElement | null, index: number) {
    inputRefs.value[index] = el;
  }

  function onDigitInput(e: Event, index: number) {
    const input = e.target as HTMLInputElement;
    // Keep only the last typed digit, discard non-numeric
    const val = input.value.replace(/\D/g, "").slice(-1);
    digits.value[index] = val;
    input.value = val;
    if (val && index < 5) {
      inputRefs.value[index + 1]?.focus();
    }
    // Auto-submit when all 6 digits are filled
    if (val && digits.value.every((d) => d !== "") && !loading.value) {
      void verifyTotp();
    }
  }

  function onDigitKeydown(e: KeyboardEvent, index: number) {
    if (e.key === "Backspace") {
      if (digits.value[index]) {
        digits.value[index] = "";
      } else if (index > 0) {
        digits.value[index - 1] = "";
        inputRefs.value[index - 1]?.focus();
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      inputRefs.value[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < 5) {
      inputRefs.value[index + 1]?.focus();
    }
  }

  function onPaste(e: ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData?.getData("text") ?? "";
    const onlyDigits = text.replace(/\D/g, "").slice(0, 6);
    for (let i = 0; i < onlyDigits.length; i++) {
      digits.value[i] = onlyDigits[i];
    }
    const nextEmpty = digits.value.findIndex((d) => d === "");
    const focusIdx = nextEmpty === -1 ? 5 : nextEmpty;
    void nextTick(() => inputRefs.value[focusIdx]?.focus());
    if (onlyDigits.length === 6 && !loading.value) {
      void verifyTotp();
    }
  }

  async function verifyTotp() {
    error.value = null;
    loading.value = true;
    try {
      const code = digits.value.join("");
      const res = await fetch("/api/auth/two-factor/verify-totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        error.value = t("errors.AUTH_005");
        digits.value = Array(6).fill("");
        void nextTick(() => inputRefs.value[0]?.focus());
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
      const optRes = await fetch("/api/auth/passkey/generate-authenticate-options", {
        method: "POST",
        credentials: "include",
      });
      if (!optRes.ok) {
        error.value = t("errors.AUTH_005");
        return;
      }
      const options = (await optRes.json()) as PublicKeyCredentialRequestOptionsJSON;
      const authResp = await startAuthentication({ optionsJSON: options });
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
        <div class="auth-icon">
          <ShieldCheck class="w-5 h-5" />
        </div>
        <h1 class="auth-title">{{ t("auth.mfaTitle") }}</h1>
        <p class="auth-subtitle">{{ t("auth.mfaSubtitle") }}</p>
      </div>

      <!-- Card -->
      <div class="card auth-card">

        <!-- TOTP digit-input mode -->
        <div v-if="!useHardwareKey" class="auth-form">

          <div class="code-label">{{ t("auth.totpLabel") }}</div>

          <!-- Two blocks of 3 digits -->
          <div class="code-row">
            <div class="code-group">
              <input
                v-for="i in [0, 1, 2]" :key="i"
                :ref="(el) => setInputRef(el as HTMLInputElement, i)"
                type="text" inputmode="numeric" maxlength="1"
                :value="digits[i]"
                class="code-digit"
                autocomplete="one-time-code"
                @input="onDigitInput($event, i)"
                @keydown="onDigitKeydown($event, i)"
                @paste="onPaste"
              />
            </div>
            <span class="code-sep" aria-hidden="true">—</span>
            <div class="code-group">
              <input
                v-for="i in [3, 4, 5]" :key="i"
                :ref="(el) => setInputRef(el as HTMLInputElement, i)"
                type="text" inputmode="numeric" maxlength="1"
                :value="digits[i]"
                class="code-digit"
                @input="onDigitInput($event, i)"
                @keydown="onDigitKeydown($event, i)"
                @paste="onPaste"
              />
            </div>
          </div>

          <p class="code-hint">{{ t("auth.mfaAutoHint") }}</p>

          <p v-if="error" class="auth-error">{{ error }}</p>

          <button class="btn btn-primary w-full" :disabled="loading || digits.some(d => !d)" @click="verifyTotp">
            {{ loading ? t("common.loading") : t("auth.verifyCode") }}
          </button>
          <button class="btn btn-ghost w-full" @click="useHardwareKey = true">
            <Key class="w-4 h-4" />
            {{ t("auth.useHardwareKey") }}
          </button>
        </div>

        <!-- Hardware key mode -->
        <div v-else class="auth-form">
          <div class="passkey-hint">
            <Key class="w-5 h-5" style="color: var(--color-primary)" />
            <p>{{ t("auth.passkeyHint") }}</p>
          </div>
          <p v-if="error" class="auth-error">{{ error }}</p>
          <button class="btn btn-primary w-full" :disabled="loading" @click="verifyPasskey">
            {{ loading ? t("common.loading") : t("auth.authenticateWithKey") }}
          </button>
          <button class="btn btn-ghost w-full" @click="useHardwareKey = false">
            {{ t("auth.useTotpInstead") }}
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

  /* ── Digit code input ────────────────────────────────────── */

  .code-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text);
    text-align: center;
  }

  .code-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.625rem;
  }

  .code-group {
    display: flex;
    gap: 0.375rem;
  }

  .code-digit {
    width: 3rem;
    height: 3.5rem;
    border: 1.5px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-surface);
    color: var(--color-text);
    font-family: "JetBrains Mono", monospace;
    font-size: 1.375rem;
    font-weight: 600;
    text-align: center;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
    caret-color: transparent;
    /* prevent text selection cursor */
    cursor: default;
  }

  .code-digit:focus {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-light);
  }

  .code-digit:not(:placeholder-shown) {
    border-color: var(--color-border-hover);
  }

  .code-sep {
    font-size: 1.25rem;
    color: var(--color-text-light);
    user-select: none;
    padding: 0 0.125rem;
  }

  .code-hint {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    text-align: center;
    margin: -0.25rem 0 0;
  }

  /* ── Passkey hint ────────────────────────────────────────── */

  .passkey-hint {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    text-align: center;
    padding: 1rem 0;
  }

  .passkey-hint p {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0;
    line-height: 1.5;
  }

  /* ── Error ───────────────────────────────────────────────── */

  .auth-error {
    font-size: 0.875rem;
    color: var(--color-danger);
    margin: 0;
    text-align: center;
  }

  /* ── Responsive ──────────────────────────────────────────── */

  @media (max-width: 380px) {
    .code-digit {
      width: 2.75rem;
      height: 3.25rem;
      font-size: 1.25rem;
    }
    .code-row {
      gap: 0.5rem;
    }
    .code-group {
      gap: 0.25rem;
    }
  }
</style>
