<script setup lang="ts">
  import { ref, onMounted } from "vue";
  import { useRoute, RouterLink } from "vue-router";
  import { useI18n } from "vue-i18n";
  import { ChevronLeft, Shield, Key, UserX, UserCheck, LayoutGrid, CreditCard } from "lucide-vue-next";

  const { t } = useI18n();
  const route = useRoute();
  const userId = route.params.id as string;

  interface UserDetail {
    id: string;
    name: string;
    email: string;
    role: string;
    emailVerified: boolean;
    banned: boolean;
    isMfaRequired: boolean;
    createdAt: string;
  }

  interface AppRole {
    id: string;
    name: string;
  }

  interface AppAccess {
    id: string;
    name: string;
    slug: string;
    icon?: string | null;
    isActive: boolean;
    subscriptionPlanId?: string | null;
    roles: AppRole[];
  }

  const user = ref<UserDetail | null>(null);
  const userApps = ref<AppAccess[]>([]);
  const editRole = ref("");
  const saving = ref(false);
  const error = ref("");
  const successMsg = ref("");

  async function fetchUser() {
    const res = await fetch(`/api/admin/users/${userId}`, { credentials: "include" });
    const data = (await res.json()) as { user: UserDetail; applications: AppAccess[]; };
    user.value = data.user;
    userApps.value = data.applications ?? [];
    editRole.value = data.user.role ?? "user";
  }

  async function saveRole() {
    saving.value = true;
    error.value = "";
    successMsg.value = "";
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: editRole.value }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { message?: string; };
        error.value = d.message ?? t("errors.SRV_001");
      } else {
        successMsg.value = "Rôle mis à jour ✓";
        await fetchUser();
      }
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : t("errors.SRV_001");
    } finally {
      saving.value = false;
    }
  }

  async function toggleMfaRequired() {
    if (!user.value) return;
    await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isMfaRequired: !user.value.isMfaRequired }),
    });
    await fetchUser();
  }

  async function toggleBan() {
    if (!user.value) return;
    const action = user.value.banned ? "enable" : "disable";
    await fetch(`/api/admin/users/${userId}/${action}`, {
      method: "POST",
      credentials: "include",
    });
    await fetchUser();
  }

  onMounted(fetchUser);
</script>

<template>
  <div class="space-y-6">
    <!-- Back link -->
    <RouterLink to="/admin/users" class="btn btn-ghost text-sm -ml-2 inline-flex">
      <ChevronLeft class="w-4 h-4" />
      {{ t("common.back") }}
    </RouterLink>

    <!-- Loading -->
    <div v-if="!user" class="text-center py-16" style="color: var(--text-muted)">
      {{ t("common.loading") }}
    </div>

    <template v-else>
      <!-- Page title + status badge -->
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex items-center gap-4">
          <!-- Avatar -->
          <div class="w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold select-none shrink-0"
            style="background: rgba(34,211,238,0.12); color: var(--accent-cyan)">
            {{ (user.name?.[0] ?? "?").toUpperCase() }}
          </div>
          <div>
            <h1 class="text-2xl font-bold leading-tight">{{ user.name }}</h1>
            <p class="text-sm mt-0.5" style="color: var(--text-muted)">{{ user.email }}</p>
          </div>
        </div>
        <span class="badge text-sm px-3 py-1.5" :class="user.banned ? 'badge-error' : 'badge-success'">
          {{ user.banned ? t("common.disabled") : t("common.active") }}
        </span>
      </div>

      <!-- 2-col layout on lg+ -->
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">

        <!-- Left column: settings (2/3 width on lg+) -->
        <div class="lg:col-span-2 space-y-5">

          <!-- Global Role -->
          <div class="card space-y-4">
            <div class="flex items-center gap-2">
              <Shield class="w-4 h-4 shrink-0" style="color: var(--accent-cyan)" />
              <h2 class="font-semibold text-sm">Rôle global</h2>
            </div>
            <div class="flex flex-wrap items-end gap-3">
              <div class="flex-1" style="min-width: 160px; max-width: 240px">
                <label class="block text-xs font-mono uppercase tracking-widest mb-2" style="color: var(--text-muted)">
                  {{ t("common.role") }}
                </label>
                <select v-model="editRole" class="select">
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                  <option value="superadmin">superadmin</option>
                </select>
              </div>
              <button class="btn btn-primary text-sm" :disabled="saving" @click="saveRole">
                {{ saving ? t("common.saving") : t("common.save") }}
              </button>
            </div>
            <p v-if="error" class="text-sm" style="color: #f87171">{{ error }}</p>
            <p v-if="successMsg" class="text-sm" style="color: var(--accent-cyan)">{{ successMsg }}</p>
          </div>

          <!-- MFA requirement -->
          <div class="card">
            <div class="flex items-start justify-between gap-4">
              <div class="flex items-start gap-2">
                <Key class="w-4 h-4 mt-0.5 shrink-0" style="color: var(--accent-cyan)" />
                <div>
                  <h2 class="font-semibold text-sm">Authentification à deux facteurs</h2>
                  <p class="text-xs mt-1" style="color: var(--text-muted)">
                    {{ user.isMfaRequired
                      ? "La MFA est actuellement requise pour cet utilisateur."
                      : "La MFA n'est pas obligatoire pour cet utilisateur." }}
                  </p>
                </div>
              </div>
              <button class="btn text-sm shrink-0" :class="user.isMfaRequired ? 'btn-secondary' : 'btn-primary'"
                @click="toggleMfaRequired">
                {{ user.isMfaRequired ? "Retirer l'obligation" : "Rendre obligatoire" }}
              </button>
            </div>
          </div>

          <!-- Ban / Unban -->
          <div class="card">
            <div class="flex items-start justify-between gap-4">
              <div class="flex items-start gap-2">
                <component :is="user.banned ? UserCheck : UserX" class="w-4 h-4 mt-0.5 shrink-0"
                  :style="user.banned ? 'color: var(--accent-cyan)' : 'color: #f87171'" />
                <div>
                  <h2 class="font-semibold text-sm">
                    {{ user.banned ? "Réactiver le compte" : "Suspendre le compte" }}
                  </h2>
                  <p class="text-xs mt-1" style="color: var(--text-muted)">
                    {{ user.banned
                      ? "Cet utilisateur est suspendu. Restaurez son accès à la plateforme."
                      : "Bloquer la connexion de cet utilisateur à la plateforme." }}
                  </p>
                </div>
              </div>
              <button class="btn text-sm shrink-0" :class="user.banned ? 'btn-primary' : 'btn-danger'"
                @click="toggleBan">
                {{ user.banned ? "Réactiver" : "Suspendre" }}
              </button>
            </div>
          </div>
        </div>

        <!-- Right column: metadata (1/3 width on lg+) -->
        <div class="space-y-5">
          <div class="card space-y-4">
            <h2 class="font-semibold text-sm" style="color: var(--text-muted)">Informations</h2>
            <dl class="space-y-3 text-sm">
              <div>
                <dt class="text-xs font-mono uppercase tracking-widest mb-0.5" style="color: var(--text-muted)">ID</dt>
                <dd class="font-mono text-xs break-all" style="color: var(--text-primary)">{{ user.id }}</dd>
              </div>
              <div>
                <dt class="text-xs font-mono uppercase tracking-widest mb-0.5" style="color: var(--text-muted)">Email
                  vérifié</dt>
                <dd>
                  <span class="badge text-xs" :class="user.emailVerified ? 'badge-success' : 'badge-inactive'">
                    {{ user.emailVerified ? "Oui" : "Non" }}
                  </span>
                </dd>
              </div>
              <div>
                <dt class="text-xs font-mono uppercase tracking-widest mb-0.5" style="color: var(--text-muted)">MFA
                  configurée</dt>
                <dd>
                  <span class="badge text-xs" :class="user.isMfaRequired ? 'badge-warning' : 'badge-inactive'">
                    {{ user.isMfaRequired ? "Requise" : "Optionnelle" }}
                  </span>
                </dd>
              </div>
              <div>
                <dt class="text-xs font-mono uppercase tracking-widest mb-0.5" style="color: var(--text-muted)">Membre
                  depuis</dt>
                <dd style="color: var(--text-primary)">
                  {{ new Date(user.createdAt).toLocaleDateString("fr-FR", {
                    year: "numeric", month: "long", day: "numeric"
                  }) }}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>

      <!-- Application access -->
      <div class="card space-y-4">
        <div class="flex items-center gap-2">
          <LayoutGrid class="w-4 h-4 shrink-0" style="color: var(--accent-cyan)" />
          <h2 class="font-semibold text-sm">Accès aux applications</h2>
        </div>

        <div v-if="userApps.length === 0" class="text-sm" style="color: var(--text-muted)">
          Cet utilisateur n'a accès à aucune application.
        </div>

        <div v-else class="rounded-lg overflow-hidden" style="border: 1px solid var(--border)">
          <table class="w-full text-sm">
            <thead>
              <tr style="background: var(--bg-secondary)">
                <th class="text-left px-3 py-2 text-xs font-mono uppercase tracking-widest"
                  style="color: var(--text-muted)">Application</th>
                <th class="text-left px-3 py-2 text-xs font-mono uppercase tracking-widest"
                  style="color: var(--text-muted)">Status</th>
                <th class="text-left px-3 py-2 text-xs font-mono uppercase tracking-widest"
                  style="color: var(--text-muted)">Plan</th>
                <th class="text-left px-3 py-2 text-xs font-mono uppercase tracking-widest"
                  style="color: var(--text-muted)">Rôles</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="app in userApps" :key="app.id" style="border-top: 1px solid var(--border)">
                <td class="px-3 py-2.5">
                  <div class="flex items-center gap-2">
                    <img v-if="app.icon" :src="app.icon" :alt="app.name"
                      class="w-5 h-5 rounded object-cover shrink-0" />
                    <div v-else class="w-5 h-5 rounded flex items-center justify-center text-xs font-bold shrink-0"
                      style="background: rgba(34,211,238,0.1); color: var(--accent-cyan)">
                      {{ (app.name[0] ?? "?").toUpperCase() }}
                    </div>
                    <div>
                      <p class="font-medium leading-tight">{{ app.name }}</p>
                      <p class="text-xs font-mono" style="color: var(--text-muted)">{{ app.slug }}</p>
                    </div>
                  </div>
                </td>
                <td class="px-3 py-2.5">
                  <span class="badge text-xs" :class="app.isActive ? 'badge-success' : 'badge-inactive'">
                    {{ app.isActive ? t("common.active") : t("common.disabled") }}
                  </span>
                </td>
                <td class="px-3 py-2.5">
                  <div v-if="app.subscriptionPlanId" class="flex items-center gap-1">
                    <CreditCard class="w-3 h-3 shrink-0" style="color: var(--text-muted)" />
                    <span class="text-xs font-mono" style="color: var(--text-muted)">{{ app.subscriptionPlanId.slice(0,
                      8) }}…</span>
                  </div>
                  <span v-else class="text-xs" style="color: var(--text-muted)">—</span>
                </td>
                <td class="px-3 py-2.5">
                  <div v-if="app.roles.length > 0" class="flex flex-wrap gap-1">
                    <span v-for="role in app.roles" :key="role.id" class="badge badge-inactive text-xs">
                      {{ role.name }}
                    </span>
                  </div>
                  <span v-else class="text-xs" style="color: var(--text-muted)">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>
