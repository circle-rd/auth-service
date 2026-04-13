<script setup lang="ts">
  import { ref, computed, onMounted } from "vue";
  import { useI18n } from "vue-i18n";
  import { useRoute, RouterLink } from "vue-router";
  import { ArrowLeft, Users, Mail, Trash2, Plus } from "lucide-vue-next";
  import OrgMemberAddModal from "../../components/admin/OrgMemberAddModal.vue";
  import OrgInviteModal from "../../components/admin/OrgInviteModal.vue";

  const { t } = useI18n();
  const route = useRoute();

  const orgId = computed(() => route.params.id as string);

  interface OrgMember {
    id: string;
    userId: string;
    role: string;
    createdAt: string;
    user?: { id: string; name: string; email: string; image?: string | null; };
  }

  interface OrgInvitation {
    id: string;
    email: string;
    role: string | null;
    status: string;
    expiresAt: string;
    createdAt: string;
  }

  interface Organization {
    id: string;
    name: string;
    slug: string;
    logo?: string | null;
    createdAt: string;
    members?: OrgMember[];
    invitations?: OrgInvitation[];
  }

  const org = ref<Organization | null>(null);
  const loading = ref(true);
  const activeTab = ref<"members" | "invitations">("members");
  const showAddMemberModal = ref(false);
  const showInviteModal = ref(false);
  const removingMemberId = ref<string | null>(null);
  const cancellingInvitationId = ref<string | null>(null);

  function initials(name: string): string {
    return name
      .split(" ")
      .map((p) => p[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }

  async function fetchOrg() {
    loading.value = true;
    try {
      const res = await fetch(`/api/admin/organizations/${orgId.value}`, { credentials: "include" });
      if (!res.ok) { org.value = null; return; }
      const data = (await res.json()) as { organization: Organization; };
      org.value = data.organization;
    } finally {
      loading.value = false;
    }
  }

  async function removeMember(userId: string) {
    removingMemberId.value = userId;
    try {
      await fetch(`/api/admin/organizations/${orgId.value}/members/${userId}`, {
        method: "DELETE",
        credentials: "include",
      });
      await fetchOrg();
    } finally {
      removingMemberId.value = null;
    }
  }

  async function cancelInvitation(invitationId: string) {
    cancellingInvitationId.value = invitationId;
    try {
      await fetch(`/api/admin/organizations/${orgId.value}/invitations/${invitationId}`, {
        method: "DELETE",
        credentials: "include",
      });
      await fetchOrg();
    } finally {
      cancellingInvitationId.value = null;
    }
  }

  const pendingInvitations = computed(() =>
    (org.value?.invitations ?? []).filter((i) => i.status === "pending"),
  );

  onMounted(fetchOrg);
</script>

<template>
  <div class="space-y-6">
    <!-- Back + header -->
    <div class="flex items-start gap-4">
      <RouterLink to="/admin/organizations" class="btn btn-ghost p-2 mt-0.5 shrink-0" :title="t('common.back')">
        <ArrowLeft class="w-4 h-4" />
      </RouterLink>
      <div v-if="loading" class="flex-1">
        <div style="height: 1.5rem; width: 12rem; background: var(--color-border); border-radius: 4px; animation: pulse 1.5s ease-in-out infinite" />
      </div>
      <div v-else-if="org" class="flex items-center gap-4 flex-1 min-w-0">
        <img v-if="org.logo" :src="org.logo" :alt="org.name" class="w-10 h-10 rounded-xl object-cover shrink-0" />
        <div v-else
          class="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold font-mono shrink-0"
          style="background: var(--color-primary-light); color: var(--color-primary)">
          {{ initials(org.name) }}
        </div>
        <div class="min-w-0">
          <h1 class="text-xl font-bold gradient-text leading-tight">{{ org.name }}</h1>
          <code class="text-xs font-mono" style="color: var(--color-text-muted)">{{ org.slug }}</code>
        </div>
      </div>
      <div v-else class="text-sm" style="color: var(--color-text-muted)">Organization not found</div>
    </div>

    <!-- Tabs -->
    <div v-if="org" class="flex items-center gap-1 rounded-lg p-0.5"
      style="background: var(--color-bg); border: 1px solid var(--color-border); width: fit-content">
      <button
        v-for="tab in [{ key: 'members', icon: Users, label: t('admin.members') }, { key: 'invitations', icon: Mail, label: t('admin.invitations') }] as const"
        :key="tab.key"
        class="px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5"
        :style="activeTab === tab.key
          ? 'background: var(--color-surface); color: var(--color-text); box-shadow: 0 1px 2px rgba(0,0,0,0.1)'
          : 'color: var(--color-text-muted)'"
        @click="activeTab = tab.key">
        <component :is="tab.icon" class="w-3.5 h-3.5" />
        {{ tab.label }}
      </button>
    </div>

    <!-- Members tab -->
    <template v-if="org && activeTab === 'members'">
      <div class="flex items-center justify-between">
        <p class="text-sm" style="color: var(--color-text-muted)">
          {{ org.members?.length ?? 0 }} {{ t("admin.members").toLowerCase() }}
        </p>
        <button class="btn btn-primary btn-sm" @click="showAddMemberModal = true">
          <Plus class="w-3.5 h-3.5" />
          {{ t("admin.addMember") }}
        </button>
      </div>

      <div class="card !p-0 overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr style="border-bottom: 1px solid var(--color-border)">
              <th class="text-left px-4 py-3 text-xs uppercase tracking-wide font-medium"
                style="color: var(--color-text-muted)">{{ t("common.name") }}</th>
              <th class="text-left px-4 py-3 text-xs uppercase tracking-wide font-medium hidden sm:table-cell"
                style="color: var(--color-text-muted)">{{ t("common.email") }}</th>
              <th class="text-left px-4 py-3 text-xs uppercase tracking-wide font-medium"
                style="color: var(--color-text-muted)">{{ t("common.role") }}</th>
              <th class="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="member in org.members" :key="member.id"
              style="border-bottom: 1px solid var(--color-border)">
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  <img v-if="member.user?.image" :src="member.user.image" :alt="member.user.name"
                    class="w-7 h-7 rounded-full object-cover shrink-0" />
                  <div v-else
                    class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold font-mono shrink-0"
                    style="background: var(--color-primary-light); color: var(--color-primary)">
                    {{ initials(member.user?.name ?? member.userId) }}
                  </div>
                  <span class="font-medium truncate">{{ member.user?.name ?? member.userId }}</span>
                </div>
              </td>
              <td class="px-4 py-3 hidden sm:table-cell" style="color: var(--color-text-muted)">
                {{ member.user?.email ?? "—" }}
              </td>
              <td class="px-4 py-3">
                <span class="badge badge-inactive text-xs">{{ member.role }}</span>
              </td>
              <td class="px-4 py-3">
                <div class="flex justify-end">
                  <button class="btn btn-ghost p-1.5" :title="t('common.delete')"
                    :disabled="removingMemberId === member.userId"
                    @click="removeMember(member.userId)">
                    <Trash2 class="w-4 h-4" style="color: #f87171" />
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!org.members?.length">
              <td colspan="4" class="px-4 py-10 text-center text-sm" style="color: var(--color-text-muted)">
                No members yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Invitations tab -->
    <template v-if="org && activeTab === 'invitations'">
      <div class="flex items-center justify-between">
        <p class="text-sm" style="color: var(--color-text-muted)">
          {{ pendingInvitations.length }} pending
        </p>
        <button class="btn btn-primary btn-sm" @click="showInviteModal = true">
          <Plus class="w-3.5 h-3.5" />
          {{ t("admin.inviteMember") }}
        </button>
      </div>

      <div class="card !p-0 overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr style="border-bottom: 1px solid var(--color-border)">
              <th class="text-left px-4 py-3 text-xs uppercase tracking-wide font-medium"
                style="color: var(--color-text-muted)">{{ t("common.email") }}</th>
              <th class="text-left px-4 py-3 text-xs uppercase tracking-wide font-medium"
                style="color: var(--color-text-muted)">{{ t("common.role") }}</th>
              <th class="text-left px-4 py-3 text-xs uppercase tracking-wide font-medium hidden md:table-cell"
                style="color: var(--color-text-muted)">Expires</th>
              <th class="text-left px-4 py-3 text-xs uppercase tracking-wide font-medium"
                style="color: var(--color-text-muted)">{{ t("common.status") }}</th>
              <th class="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="inv in org.invitations" :key="inv.id"
              style="border-bottom: 1px solid var(--color-border)">
              <td class="px-4 py-3 font-medium">{{ inv.email }}</td>
              <td class="px-4 py-3">
                <span class="badge badge-inactive text-xs">{{ inv.role ?? "member" }}</span>
              </td>
              <td class="px-4 py-3 hidden md:table-cell" style="color: var(--color-text-muted)">
                {{ new Date(inv.expiresAt).toLocaleDateString() }}
              </td>
              <td class="px-4 py-3">
                <span class="badge text-xs" :class="inv.status === 'pending' ? 'badge-success' : 'badge-inactive'">
                  {{ inv.status }}
                </span>
              </td>
              <td class="px-4 py-3">
                <div class="flex justify-end">
                  <button v-if="inv.status === 'pending'" class="btn btn-ghost p-1.5"
                    :title="t('common.cancel')"
                    :disabled="cancellingInvitationId === inv.id"
                    @click="cancelInvitation(inv.id)">
                    <Trash2 class="w-4 h-4" style="color: #f87171" />
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!org.invitations?.length">
              <td colspan="5" class="px-4 py-10 text-center text-sm" style="color: var(--color-text-muted)">
                No invitations yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <OrgMemberAddModal :open="showAddMemberModal" :org-id="orgId"
      @close="showAddMemberModal = false" @added="showAddMemberModal = false; fetchOrg()" />

    <OrgInviteModal :open="showInviteModal" :org-id="orgId"
      @close="showInviteModal = false" @invited="showInviteModal = false; fetchOrg()" />
  </div>
</template>

<style scoped>
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
