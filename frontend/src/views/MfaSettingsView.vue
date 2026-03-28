<script setup lang="ts">
  import { ref, onMounted, computed } from "vue";
  import { useI18n } from "vue-i18n";
  import { useAuthStore } from "../stores/auth.js";
  import { Shield, Key, Plus, Trash2, CheckCircle, Eye, EyeOff, QrCode } from "lucide-vue-next";

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
      totpError.value = "Veuillez saisir votre mot de passe pour continuer.";
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
        totpError.value = data.message ?? "Mot de passe incorrect ou activation impossible.";
        return;
      }
      totpUri.value = data.totpURI;
      totpQrUrl.value = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data.totpURI)}`;
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
        totpError.value = data.message ?? "Échec de la désactivation.";
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
        totpError.value = data.message ?? "Échec de la régénération.";
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
        passkeyError.value = "Impossible d'initier l'enregistrement.";
        return;
      }
      const options = (await optRes.json()) as PublicKeyCredentialCreationOptions;

      // 2. Browser prompts for passkey creation
      const credential = await navigator.credentials.create({ publicKey: options as PublicKeyCredentialCreationOptions });
      if (!credential) {
        passkeyError.value = "Enregistrement annulé.";
        return;
      }

      // 3. Send credential to server to verify and persist
      const verifyRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credential),
      });
      if (!verifyRes.ok) {
        passkeyError.value = "Échec de l'enregistrement côté serveur.";
        return;
      }
      passkeySuccess.value = "Clé de sécurité enregistrée avec succès.";
      await fetchPasskeys();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("NotAllowedError") || msg.includes("cancelled")) {
        passkeyError.value = "Enregistrement annulé par l'utilisateur.";
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
    return new Date(str).toLocaleDateString("fr-FR", {
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
  <div class="space-y-8">
    <h1 class="text-2xl font-bold gradient-text">{{ t("profile.mfaSettings") }}</h1>

    <!-- ── TOTP Section ──────────────────────────────────────────────────── -->
    <div class="card space-y-5">
      <div class="flex items-start gap-3">
        <Shield class="w-5 h-5 mt-0.5 shrink-0" style="color: var(--accent-cyan)" />
        <div>
          <h2 class="font-semibold">Application d'authentification (TOTP)</h2>
          <p class="text-sm mt-0.5" style="color: var(--text-muted)">
            Google Authenticator, Authy, Bitwarden Authenticator…
          </p>
        </div>
      </div>

      <!-- Status + actions when enabled -->
      <template v-if="totpEnabled && totpStep === 'idle'">
        <div class="flex items-center gap-3 flex-wrap">
          <span class="badge badge-success text-sm px-3 py-1">
            <CheckCircle class="w-3.5 h-3.5 mr-1" />
            Activé
          </span>
          <button class="btn btn-secondary text-sm" @click="regenerateBackupCodes">
            Régénérer les codes de secours
          </button>
          <button class="btn btn-danger text-sm" :disabled="disablingTotp" @click="disableTotp">
            {{ disablingTotp ? t("common.loading") : "Désactiver" }}
          </button>
        </div>
        <!-- Show regenerated backup codes -->
        <div v-if="backupCodes.length > 0 && showBackupCodes" class="space-y-3">
          <div class="flex items-center justify-between">
            <p class="text-sm font-medium">Nouveaux codes de secours</p>
            <button class="btn btn-ghost text-xs" @click="showBackupCodes = false">Masquer</button>
          </div>
          <div class="grid grid-cols-2 gap-1.5 p-3 rounded-lg font-mono text-sm"
            style="background: var(--bg-secondary)">
            <span v-for="code in backupCodes" :key="code">{{ code }}</span>
          </div>
        </div>
      </template>

      <!-- Not enabled yet -->
      <template v-else-if="totpStep === 'idle'">
        <div class="flex items-center gap-3">
          <span class="badge badge-inactive text-sm px-3 py-1">Non activé</span>
          <button class="btn btn-primary text-sm" @click="beginTotpSetup">Activer</button>
        </div>
      </template>

      <!-- Step 0: Confirm current password -->
      <template v-else-if="totpStep === 'confirm-password'">
        <div class="space-y-4">
          <p class="text-sm" style="color: var(--text-muted)">
            Pour activer la double authentification, confirmez votre mot de passe actuel.
          </p>
          <div class="space-y-2">
            <label class="block text-sm font-medium">Mot de passe actuel</label>
            <div class="relative" style="max-width: 320px">
              <input v-model="totpPassword" :type="showTotpPassword ? 'text' : 'password'" placeholder="••••••••"
                class="input pr-10 w-full" @keydown.enter="startTotpSetup" />
              <button type="button" class="absolute inset-y-0 right-0 flex items-center px-3"
                style="color: var(--text-muted)" @click="showTotpPassword = !showTotpPassword">
                <EyeOff v-if="showTotpPassword" class="w-4 h-4" />
                <Eye v-else class="w-4 h-4" />
              </button>
            </div>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-primary text-sm" :disabled="!totpPassword" @click="startTotpSetup">
              Continuer
            </button>
            <button class="btn btn-ghost text-sm" @click="totpStep = 'idle'">Annuler</button>
          </div>
        </div>
      </template>

      <!-- Step 1: Show QR code -->
      <template v-else-if="totpStep === 'setup'">
        <div class="space-y-4">
          <div class="flex items-center gap-2" style="color: var(--text-muted)">
            <QrCode class="w-4 h-4 shrink-0" />
            <p class="text-sm">
              Scannez ce QR code avec votre application d'authentification, puis entrez le code à 6 chiffres.
            </p>
          </div>
          <div class="flex flex-col sm:flex-row gap-6 items-start">
            <img :src="totpQrUrl" alt="QR Code TOTP" class="w-40 h-40 rounded-lg border shrink-0"
              style="border-color: var(--border)" />
            <div class="flex-1 space-y-3">
              <div>
                <p class="text-xs font-mono uppercase tracking-widest mb-1" style="color: var(--text-muted)">URI
                  manuelle</p>
                <code class="text-xs break-all block p-2 rounded"
                  style="background: var(--bg-secondary); color: var(--text-primary)">{{ totpUri }}</code>
              </div>
              <div class="space-y-2">
                <label class="block text-sm font-medium">Code de vérification</label>
                <input v-model="totpCode" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6"
                  placeholder="000000" class="input font-mono text-center text-lg tracking-widest"
                  style="max-width: 160px" @keydown.enter="verifyTotpCode" />
              </div>
              <div class="flex gap-2">
                <button class="btn btn-primary text-sm" :disabled="totpCode.length < 6" @click="verifyTotpCode">
                  Vérifier
                </button>
                <button class="btn btn-ghost text-sm" @click="totpStep = 'idle'">Annuler</button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- Step 2: Backup codes revealed after verify -->
      <template v-else-if="totpStep === 'backup-codes'">
        <div class="space-y-4">
          <div class="flex items-center gap-2" style="color: var(--accent-cyan)">
            <CheckCircle class="w-4 h-4" />
            <span class="text-sm font-medium">TOTP activé avec succès !</span>
          </div>
          <p class="text-sm" style="color: var(--text-muted)">
            Conservez ces codes de secours dans un endroit sûr. Ils ne seront plus affichés.
          </p>
          <div class="grid grid-cols-2 gap-1.5 p-3 rounded-lg font-mono text-sm"
            style="background: var(--bg-secondary)">
            <span v-for="code in backupCodes" :key="code">{{ code }}</span>
          </div>
          <button class="btn btn-primary text-sm" @click="totpStep = 'idle'">
            J'ai sauvegardé mes codes
          </button>
        </div>
      </template>

      <p v-if="totpError" class="text-sm" style="color: #f87171">{{ totpError }}</p>
    </div>

    <!-- ── Passkeys Section ─────────────────────────────────────────────── -->
    <div class="card space-y-5">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex items-start gap-3">
          <Key class="w-5 h-5 mt-0.5 shrink-0" style="color: var(--accent-cyan)" />
          <div>
            <h2 class="font-semibold">Clés de sécurité (Passkeys / YubiKey)</h2>
            <p class="text-sm mt-0.5" style="color: var(--text-muted)">
              FIDO2 / WebAuthn — compatible YubiKey 5+ et autres clés FIDO2
            </p>
          </div>
        </div>
        <button class="btn btn-primary text-sm shrink-0" :disabled="registeringPasskey" @click="registerPasskey">
          <Plus class="w-4 h-4" />
          {{ registeringPasskey ? "Enregistrement…" : "Ajouter une clé" }}
        </button>
      </div>

      <div v-if="passkeyError" class="text-sm" style="color: #f87171">{{ passkeyError }}</div>
      <div v-if="passkeySuccess" class="text-sm" style="color: var(--accent-cyan)">{{ passkeySuccess }}</div>

      <div v-if="passkeys.length === 0" class="text-sm" style="color: var(--text-muted)">
        Aucune clé enregistrée.
      </div>

      <div v-else class="space-y-2">
        <div v-for="pk in passkeys" :key="pk.id" class="flex items-center gap-3 p-3 rounded-lg"
          style="background: var(--bg-secondary)">
          <Key class="w-4 h-4 shrink-0" style="color: var(--text-muted)" />
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium">{{ pk.name ?? "Clé sans nom" }}</p>
            <p class="text-xs" style="color: var(--text-muted)">
              Enregistrée le {{ formatDate(pk.createdAt) }}
            </p>
          </div>
          <button class="btn btn-ghost p-1.5 shrink-0" :disabled="deletingPasskey.has(pk.id)"
            :title="'Supprimer cette clé'" @click="deletePasskey(pk.id)">
            <Trash2 class="w-4 h-4" style="color: #f87171" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
