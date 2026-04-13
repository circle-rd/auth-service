<script setup lang="ts">
  import { ref, computed, onMounted } from "vue";
  import { useI18n } from "vue-i18n";
  import { useRouter } from "vue-router";
  import {
    Search,
    Plus,
    ChevronUp,
    ChevronDown,
    ChevronsUpDown,
    ChevronLeft,
    ChevronRight,
    UserX,
    UserCheck,
    Trash2,
  } from "lucide-vue-next";
  import UserCreateModal from "../../components/admin/UserCreateModal.vue";

  const { t } = useI18n();
  const router = useRouter();

  interface User {
    id: string;
    name: string;
    email: string;
    role?: string;
    banned?: boolean;
    createdAt: string;
  }

  const users = ref<User[]>([]);
  const total = ref(0);
  const searchQuery = ref("");
  const loading = ref(false);
  const page = ref(1);
  const LIMIT = 20;

  // Sort (client-side on current page)
  type SortField = "name" | "email" | "role" | "status";
  const sortBy = ref<SortField>("name");
  const sortDir = ref<"asc" | "desc">("asc");

  // Create modal
  const showCreateModal = ref(false);

  // Ban / Delete in-list state
  const togglingBanId = ref<string | null>(null);
  const confirmDeleteId = ref<string | null>(null);
  const deletingId = ref<string | null>(null);

  async function fetchUsers() {
    loading.value = true;
    try {
      const params = new URLSearchParams({
        page: String(page.value),
        limit: String(LIMIT),
        ...(searchQuery.value ? { search: searchQuery.value } : {}),
      });
      const res = await fetch(`/api/admin/users?${params}`, { credentials: "include" });
      const data = (await res.json()) as { users: User[]; total: number; };
      users.value = data.users;
      total.value = data.total;
    } finally {
      loading.value = false;
    }
  }

  async function onSearch() {
    page.value = 1;
    await fetchUsers();
  }

  function setSort(field: SortField) {
    if (sortBy.value === field) sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
    else { sortBy.value = field; sortDir.value = "asc"; }
  }

  function openUser(id: string) {
    router.push(`/admin/users/${id}`);
  }

  async function toggleBan(user: User) {
    togglingBanId.value = user.id;
    const action = user.banned ? "enable" : "disable";
    try {
      await fetch(`/api/admin/users/${user.id}/${action}`, {
        method: "POST",
        credentials: "include",
      });
      await fetchUsers();
    } finally {
      togglingBanId.value = null;
    }
  }

  async function deleteUserFromList(id: string) {
    deletingId.value = id;
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok || res.status === 204) {
        confirmDeleteId.value = null;
        await fetchUsers();
      }
    } finally {
      deletingId.value = null;
    }
  }

  const sortedUsers = computed(() => {
    const list = users.value.slice();
    list.sort((a, b) => {
      let va: string, vb: string;
      if (sortBy.value === "status") {
        va = a.banned ? "1" : "0";
        vb = b.banned ? "1" : "0";
      } else if (sortBy.value === "role") {
        va = a.role ?? "user";
        vb = b.role ?? "user";
      } else {
        va = (a[sortBy.value] ?? "").toLowerCase();
        vb = (b[sortBy.value] ?? "").toLowerCase();
      }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir.value === "asc" ? cmp : -cmp;
    });
    return list;
  });

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / LIMIT)));

  async function prevPage() {
    if (page.value > 1) { page.value--; await fetchUsers(); }
  }
  async function nextPage() {
    if (page.value < totalPages.value) { page.value++; await fetchUsers(); }
  }

  onMounted(fetchUsers);
</script>

<template>
  <div class="space-y-5">
    <!-- Header -->
    <div class="flex items-center justify-between gap-4 flex-wrap">
      <div>
        <h1 class="text-2xl font-bold gradient-text">{{ t("admin.users") }}</h1>
        <p v-if="total > 0" class="text-sm mt-0.5" style="color: var(--color-text-muted)">
          {{ total }} utilisateur{{ total > 1 ? "s" : "" }}
        </p>
      </div>
      <button class="btn btn-primary" @click="showCreateModal = true">
        <Plus class="w-4 h-4" />
        {{ t("admin.newUser") }}
      </button>
    </div>

    <!-- Search -->
    <div class="relative" style="max-width: 360px">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
        style="color: var(--color-text-muted)" />
      <input v-model="searchQuery" type="text" :placeholder="t('common.search')" class="input pl-9" @input="onSearch" />
    </div>

    <!-- Table -->
    <div class="card !p-0 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr style="border-bottom: 1px solid var(--color-border)">
              <!-- Name -->
              <th class="text-left px-4 py-3 cursor-pointer select-none" style="color: var(--color-text-muted)"
                @click="setSort('name')">
                <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                  {{ t("common.name") }}
                  <ChevronsUpDown v-if="sortBy !== 'name'" class="w-3 h-3 opacity-40" />
                  <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                  <ChevronDown v-else class="w-3 h-3" />
                </span>
              </th>
              <!-- Email -->
              <th class="text-left px-4 py-3 cursor-pointer select-none hidden sm:table-cell"
                style="color: var(--color-text-muted)" @click="setSort('email')">
                <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                  {{ t("common.email") }}
                  <ChevronsUpDown v-if="sortBy !== 'email'" class="w-3 h-3 opacity-40" />
                  <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                  <ChevronDown v-else class="w-3 h-3" />
                </span>
              </th>
              <!-- Role -->
              <th class="text-left px-4 py-3 cursor-pointer select-none" style="color: var(--color-text-muted)"
                @click="setSort('role')">
                <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                  {{ t("common.role") }}
                  <ChevronsUpDown v-if="sortBy !== 'role'" class="w-3 h-3 opacity-40" />
                  <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                  <ChevronDown v-else class="w-3 h-3" />
                </span>
              </th>
              <!-- Status -->
              <th class="text-left px-4 py-3 cursor-pointer select-none hidden md:table-cell"
                style="color: var(--color-text-muted)" @click="setSort('status')">
                <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                  {{ t("common.status") }}
                  <ChevronsUpDown v-if="sortBy !== 'status'" class="w-3 h-3 opacity-40" />
                  <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                  <ChevronDown v-else class="w-3 h-3" />
                </span>
              </th>
              <th class="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="5" class="text-center py-10" style="color: var(--color-text-muted)">
                {{ t("common.loading") }}
              </td>
            </tr>
            <template v-else>
              <tr v-for="user in sortedUsers" :key="user.id" class="transition-colors hover:bg-[--bg-secondary] cursor-pointer"
                style="border-bottom: 1px solid var(--color-border)" @click="openUser(user.id)">
                <!-- Name -->
                <td class="px-4 py-3">
                  <div class="flex items-center gap-2.5">
                    <div
                      class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 select-none"
                      style="background: var(--color-primary-light); color: var(--color-primary)">
                      {{ (user.name?.[0] ?? "?").toUpperCase() }}
                    </div>
                    <span class="font-medium">{{ user.name }}</span>
                  </div>
                </td>
                <!-- Email -->
                <td class="px-4 py-3 hidden sm:table-cell" style="color: var(--color-text-muted)">
                  {{ user.email }}
                </td>
                <!-- Role -->
                <td class="px-4 py-3">
                  <span class="badge" :class="user.role === 'superadmin'
                      ? 'badge-success'
                      : user.role === 'admin'
                        ? 'badge-warning'
                        : 'badge-inactive'
                    ">
                    {{ user.role ?? "user" }}
                  </span>
                </td>
                <!-- Status -->
                <td class="px-4 py-3 hidden md:table-cell">
                  <span class="badge" :class="user.banned ? 'badge-error' : 'badge-success'">
                    {{ user.banned ? t("common.disabled") : t("common.active") }}
                  </span>
                </td>
                <!-- Actions -->
                <td class="px-4 py-3 text-right" @click.stop>
                  <div v-if="confirmDeleteId === user.id" class="flex items-center gap-2 justify-end">
                    <span class="text-xs" style="color: var(--color-text-muted)">{{ t('admin.deleteUserConfirm') }}</span>
                    <button class="btn btn-danger py-1 px-2 text-xs" :disabled="deletingId === user.id"
                      @click="deleteUserFromList(user.id)">
                      {{ deletingId === user.id ? '…' : t('common.yes') }}
                    </button>
                    <button class="btn btn-ghost py-1 px-2 text-xs" @click="confirmDeleteId = null">
                      {{ t('common.no') }}
                    </button>
                  </div>
                  <div v-else class="flex items-center gap-1 justify-end">
                    <button class="btn btn-ghost p-1.5"
                      :title="user.banned ? t('admin.unbanUser') : t('admin.banUser')"
                      :disabled="togglingBanId === user.id"
                      @click="toggleBan(user)">
                      <UserCheck v-if="user.banned" class="w-4 h-4" style="color: var(--color-primary)" />
                      <UserX v-else class="w-4 h-4" style="color: #f59e0b" />
                    </button>
                    <button class="btn btn-ghost p-1.5" :title="t('common.delete')"
                      @click="confirmDeleteId = user.id">
                      <Trash2 class="w-4 h-4" style="color: #f87171" />
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="sortedUsers.length === 0">
                <td colspan="5" class="text-center py-10 text-sm" style="color: var(--color-text-muted)">
                  No users found.
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="flex items-center justify-between px-4 py-3"
        style="border-top: 1px solid var(--color-border)">
        <span class="text-xs" style="color: var(--color-text-muted)">
          {{ (page - 1) * LIMIT + 1 }}–{{ Math.min(page * LIMIT, total) }} de {{ total }}
        </span>
        <div class="flex items-center gap-2">
          <button class="btn btn-ghost p-1.5" :disabled="page === 1" @click="prevPage">
            <ChevronLeft class="w-4 h-4" />
          </button>
          <span class="text-sm font-medium px-1">{{ page }} / {{ totalPages }}</span>
          <button class="btn btn-ghost p-1.5" :disabled="page >= totalPages" @click="nextPage">
            <ChevronRight class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>

    <!-- Create user modal -->
    <UserCreateModal :open="showCreateModal" @close="showCreateModal = false"
      @created="showCreateModal = false; fetchUsers()" />
  </div>
</template>
