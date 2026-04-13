<script setup lang="ts">
  import { ref, onMounted, computed } from "vue";
  import { useI18n } from "vue-i18n";
  import { useAuthStore } from "../stores/auth.js";
  import { Shield, Key, Plus, Trash2, CheckCircle, Eye, EyeOff, QrCode } from "lucide-vue-next";
  import { startRegistration } from "@simplewebauthn/browser";
  import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
  import QRCode from "qrcode";

  const { t } = useI18n();
  const authStore = useAuthStore();

  // ── State ──────────────────────────────────────────────────────────────────────

  // TOTP
  type TotpStep = "idle" | "confirm-password" | "setup" | "backup-codes";
  const totpStep = ref<TotpStep>("idle");
  const totpEnabled = ref(false);
  const totpUri = ref("");
  const totpQrUrl = ref("");
  const totpCode = ref("");
  const totpPassword = ref("");
  const showTotpPassword = ref(false);
  const totpError = ref("");
  const backupCodes = ref<string[]>([]);
  const showBackupCodes = ref(false);
  const disablingTotp = ref(false);

  // Passkeys
  interface PasskeyEntry {
    id: string;
    name?: string | null;
    createdAt: string;
  }
  const passkeys = ref<PasskeyEntry[]>([]);
  const registeringPasskey = ref(false);
  const deletingPasskey = ref<Set<string>>(new Set());
  const passkeyError = ref("");
  const passkeySuccess = ref("");

  // ── TOTP methods ───────────────────────────────────────────────────────────────

  function beginTotpSetup(): void {
    totpPassword.value = "";
    showTotpPassword.value = false;
    totpError.value = "";
    totpStep.value = "confirm-password";
  }

  async function startTotpSetup(): Promise<void> {
    if (!totpPassword.value) {
      totpError.value = "Please enter your password to continue.";
      return;
    }
    totpError.value = "";
    try {
      const res = await fetch("/api/auth/two-factor/enable", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: totpPassword.value }),
      });
      const data = (await res.json()) as { totpURI?: string; message?: string; };
      if (!res.ok || !data.totpURI) {
        totpError.value = data.message ?? "Incorrect password or activation failed.";
        return;
      }
      totpUri.value = data.totpURI;
      // Generate QR code locally to avoid external service dependency and privacy concerns
      totpQrUrl.value = await QRCode.toDataURL(data.totpURI, {
        width: 200,
        margin: 2,
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
      });
      totpCode.value = "";
      totpPassword.value = "";
      totpStep.value = "setup";
    } catch {
      totpError.value = t("errors.SRV_001");
    }
  }

  async function verifyTotpCode(): Promise<void> {
    totpError.value = "";
    try {
      const res = await fetch("/api/auth/two-factor/verify-totp", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: totpCode.value }),
      });
      const data = (await res.json()) as { backupCodes?: string[]; message?: string; };
      if (!res.ok) {
        totpError.value = data.message ?? t("errors.AUTH_005");
        return;
      }
      backupCodes.value = data.backupCodes ?? [];
      totpEnabled.value = true;
      totpCode.value = "";
      totpStep.value = "backup-codes";
      await authStore.fetchSession();
    } catch {
      totpError.value = t("errors.SRV_001");
    }
  }

  async function disableTotp(): Promise<void> {
    disablingTotp.value = true;
    totpError.value = "";
    try {
      const res = await fetch("/api/auth/two-factor/disable", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = (await res.json()) as { message?: string; };
        totpError.value = data.message ?? "Failed to disable TOTP.";
        return;
      }
      totpEnabled.value = false;
      totpStep.value = "idle";
      await authStore.fetchSession();
    } catch {
      totpError.value = t("errors.SRV_001");
    } finally {
      disablingTotp.value = false;
    }
  }

  async function regenerateBackupCodes(): Promise<void> {
    totpError.value = "";
    try {
      const res = await fetch("/api/auth/two-factor/generate-backup-codes", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { backupCodes?: string[]; message?: string; };
      if (!res.ok || !data.backupCodes) {
        totpError.value = data.message ?? "Failed to regenerate backup codes.";
        return;
      }
      backupCodes.value = data.backupCodes;
      showBackupCodes.value = true;
    } catch {
      totpError.value = t("errors.SRV_001");
    }
  }

  // ── Passkey methods ────────────────────────────────────────────────────────────

  async function fetchPasskeys(): Promise<void> {
    try {
      const res = await fetch("/api/auth/passkey/list-user-passkeys", {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = (await res.json()) as PasskeyEntry[];
      passkeys.value = Array.isArray(data) ? data : [];
    } catch {
      /* silent */
    }
  }

  async function registerPasskey(): Promise<void> {
    registeringPasskey.value = true;
    passkeyError.value = "";
    passkeySuccess.value = "";
    try {
      // 1. Get registration options from server
      const optRes = await fetch("/api/auth/passkey/generate-register-options", {
        method: "POST",
        credentials: "include",
      });
      if (!optRes.ok) {
        passkeyError.value = "Could not initiate passkey registration.";
        return;
      }
      const options = (await optRes.json()) as PublicKeyCredentialCreationOptionsJSON;

      // 2. Browser prompts for passkey creation — startRegistration handles proper serialization
      const attResp = await startRegistration({ optionsJSON: options });

      // 3. Send serialized credential to server to verify and persist
      const verifyRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attResp),
      });
      if (!verifyRes.ok) {
        passkeyError.value = "Server-side registration failed.";
        return;
      }
      passkeySuccess.value = "Security key registered successfully.";
      await fetchPasskeys();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("NotAllowedError") || msg.includes("cancelled")) {
        passkeyError.value = "Registration cancelled by user.";
      } else {
        passkeyError.value = msg || t("errors.SRV_001");
      }
    } finally {
      registeringPasskey.value = false;
    }
  }

  async function deletePasskey(id: string): Promise<void> {
    deletingPasskey.value = new Set([...deletingPasskey.value, id]);
    passkeyError.value = "";
    try {
      await fetch(`/api/auth/passkey/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      await fetchPasskeys();
    } finally {
      deletingPasskey.value = new Set([...deletingPasskey.value].filter((x) => x !== id));
    }
  }

  function formatDate(str: string): string {
    return new Date(str).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  // Derive totpEnabled from the session user — BetterAuth stores twoFactorEnabled
  const sessionTotpEnabled = computed(() => {
    const u = authStore.user as Record<string, unknown> | null;
    return Boolean(u?.twoFactorEnabled);
  });

  onMounted(async () => {
    totpEnabled.value = sessionTotpEnabled.value;
    await fetchPasskeys();
  });
</script>

<template>
  <div class="mfa-root">

    <!-- ── TOTP Section ──────────────────────────────────────────────────── -->
    <div class="mfa-section-group">
      <div class="section-header">
        <Shield class="w-5 h-5 shrink-0" style="color: var(--color-primary)" />
        <div>
          <h2 class="section-title">Authenticator App (TOTP)</h2>
          <p class="section-desc">Google Authenticator, Authy, Bitwarden Authenticator…</p>
        </div>
      </div>

      <!-- Status + actions when enabled -->
      <template v-if="totpEnabled && totpStep === 'idle'">
        <div class="status-row">
          <span class="badge badge-success">
            <CheckCircle class="w-3.5 h-3.5 mr-1" />
            Enabled
          </span>
          <button class="btn btn-secondary btn-sm" @click="regenerateBackupCodes">
            Regenerate backup codes
          </button>
          <button class="btn btn-danger btn-sm" :disabled="disablingTotp" @click="disableTotp">
            {{ disablingTotp ? t("common.loading") : "Disable" }}
          </button>
        </div>
        <!-- Show regenerated backup codes -->
        <div v-if="backupCodes.length > 0 && showBackupCodes" class="backup-codes-section">
          <div class="backup-codes-header">
            <p class="text-sm font-medium">New backup codes</p>
            <button class="btn btn-ghost btn-sm" @click="showBackupCodes = false">Hide</button>
          </div>
          <div class="backup-codes-grid">
            <span v-for="code in backupCodes" :key="code" class="backup-code">{{ code }}</span>
          </div>
        </div>
      </template>

      <!-- Not enabled yet -->
      <template v-else-if="totpStep === 'idle'">
        <div class="status-row">
          <span class="badge badge-inactive">Not enabled</span>
          <button class="btn btn-primary btn-sm" @click="beginTotpSetup">Enable</button>
        </div>
      </template>

      <!-- Step 0: Confirm current password -->
      <template v-else-if="totpStep === 'confirm-password'">
        <div class="setup-step">
          <p class="text-sm" style="color: var(--color-text-muted)">
            To enable two-factor authentication, please confirm your current password.
          </p>
          <div class="form-group">
            <label class="form-label">{{ t("profile.currentPassword") }}</label>
            <div class="password-input-wrap">
              <input v-model="totpPassword" :type="showTotpPassword ? 'text' : 'password'" placeholder="••••••••"
                class="input" @keydown.enter="startTotpSetup" />
              <button type="button" class="password-toggle" style="color: var(--color-text-muted)"
                @click="showTotpPassword = !showTotpPassword">
                <EyeOff v-if="showTotpPassword" class="w-4 h-4" />
                <Eye v-else class="w-4 h-4" />
              </button>
            </div>
          </div>
          <div class="step-actions">
            <button class="btn btn-primary btn-sm" :disabled="!totpPassword" @click="startTotpSetup">
              Continue
            </button>
            <button class="btn btn-ghost btn-sm" @click="totpStep = 'idle'">{{ t("common.cancel") }}</button>
          </div>
        </div>
      </template>

      <!-- Step 1: Show QR code -->
      <template v-else-if="totpStep === 'setup'">
        <div class="setup-step">
          <div class="qr-hint">
            <QrCode class="w-4 h-4 shrink-0" />
            <p class="text-sm">
              Scan this QR code with your authenticator app, then enter the 6-digit code.
            </p>
          </div>
          <div class="qr-layout">
            <img :src="totpQrUrl" alt="TOTP QR Code" class="qr-image" />
            <div class="qr-form">
              <div>
                <p class="text-xs font-mono uppercase tracking-widest mb-1" style="color: var(--color-text-muted)">
                  Manual URI
                </p>
                <code class="manual-uri">{{ totpUri }}</code>
              </div>
              <div class="form-group">
                <label class="form-label">Verification code</label>
                <input v-model="totpCode" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6"
                  placeholder="000000" class="input font-mono text-center"
                  style="max-width: 160px; font-size: 1.125rem; letter-spacing: 0.2em"
                  @keydown.enter="verifyTotpCode" />
              </div>
              <div class="step-actions">
                <button class="btn btn-primary btn-sm" :disabled="totpCode.length < 6" @click="verifyTotpCode">
                  Verify
                </button>
                <button class="btn btn-ghost btn-sm" @click="totpStep = 'idle'">{{ t("common.cancel") }}</button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- Step 2: Backup codes revealed after verify -->
      <template v-else-if="totpStep === 'backup-codes'">
        <div class="setup-step">
          <div class="success-notice">
            <CheckCircle class="w-4 h-4" />
            <span class="text-sm font-medium">TOTP enabled successfully!</span>
          </div>
          <p class="text-sm" style="color: var(--color-text-muted)">
            Save these backup codes in a safe place. They will not be shown again.
          </p>
          <div class="backup-codes-grid">
            <span v-for="code in backupCodes" :key="code" class="backup-code">{{ code }}</span>
          </div>
          <button class="btn btn-primary btn-sm" @click="totpStep = 'idle'">
            I have saved my codes
          </button>
        </div>
      </template>

      <p v-if="totpError" class="text-sm" style="color: var(--color-danger)">{{ totpError }}</p>
    </div>

    <!-- ── Passkeys Section ─────────────────────────────────────────────── -->
    <div class="mfa-section-group mfa-section-group--last">
      <div class="section-header-row">
        <div class="section-header">
          <Key class="w-5 h-5 shrink-0" style="color: var(--color-primary)" />
          <div>
            <h2 class="section-title">Security Keys (Passkeys / YubiKey)</h2>
            <p class="section-desc">FIDO2 / WebAuthn — compatible with YubiKey 5+ and other FIDO2 keys</p>
          </div>
        </div>
        <button class="btn btn-primary btn-sm" :disabled="registeringPasskey" @click="registerPasskey">
          <Plus class="w-4 h-4" />
          {{ registeringPasskey ? t("common.loading") : "Add key" }}
        </button>
      </div>

      <div v-if="passkeyError" class="text-sm" style="color: var(--color-danger)">{{ passkeyError }}</div>
      <div v-if="passkeySuccess" class="text-sm" style="color: var(--color-success)">{{ passkeySuccess }}</div>

      <div v-if="passkeys.length === 0" class="text-sm" style="color: var(--color-text-muted)">
        No security keys registered.
      </div>

      <div v-else class="passkeys-list">
        <div v-for="pk in passkeys" :key="pk.id" class="passkey-item">
          <Key class="w-4 h-4 shrink-0" style="color: var(--color-text-muted)" />
          <div class="passkey-info">
            <p class="text-sm font-medium">{{ pk.name ?? "Unnamed key" }}</p>
            <p class="text-xs" style="color: var(--color-text-muted)">
              Registered {{ formatDate(pk.createdAt) }}
            </p>
          </div>
          <button class="btn btn-ghost" style="padding: 0.375rem" :disabled="deletingPasskey.has(pk.id)"
            title="Delete this key" @click="deletePasskey(pk.id)">
            <Trash2 class="w-4 h-4" style="color: var(--color-danger)" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .mfa-root {
    display: flex;
    flex-direction: column;
  }

  .mfa-section-group {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 2rem 0;
    border-bottom: 1px solid var(--color-border);
  }

  .mfa-section-group--last {
    border-bottom: none;
    padding-bottom: 0;
  }

  .section-header {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .section-header-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .section-title {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }

  .section-desc {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0.25rem 0 0;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .setup-step {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .step-actions {
    display: flex;
    gap: 0.5rem;
  }

  .password-input-wrap {
    position: relative;
    max-width: 20rem;
  }

  .password-toggle {
    position: absolute;
    inset-y: 0;
    right: 0;
    display: flex;
    align-items: center;
    padding: 0 0.75rem;
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .qr-hint {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    color: var(--color-text-muted);
  }

  .qr-layout {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  @media (min-width: 640px) {
    .qr-layout {
      flex-direction: row;
      align-items: flex-start;
    }
  }

  .qr-image {
    width: 10rem;
    height: 10rem;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .qr-form {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .manual-uri {
    font-size: 0.75rem;
    word-break: break-all;
    display: block;
    padding: 0.5rem;
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }

  .success-notice {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-success);
  }

  .backup-codes-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .backup-codes-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .backup-codes-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.375rem;
    padding: 0.75rem;
    border-radius: 6px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
  }

  .backup-code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8125rem;
    color: var(--color-text);
  }

  .passkeys-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .passkey-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    border-radius: 6px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
  }

  .passkey-info {
    flex: 1;
    min-width: 0;
  }
</style>
