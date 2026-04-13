<script setup lang="ts">
  import { ref, computed, onMounted } from "vue";
  import { useI18n } from "vue-i18n";
  import { useRouter } from "vue-router";
  import { Plus, Search, ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight, Trash2 } from "lucide-vue-next";
  import OrgCreateModal from "../../components/admin/OrgCreateModal.vue";

  const { t } = useI18n();
  const router = useRouter();

  interface Organization {
    id: string;
    name: string;
    slug: string;
    logo?: string | null;
    createdAt: string;
    metadata?: string | null;
  }

  const orgs = ref<Organization[]>([]);
  const loading = ref(false);
  const deletingId = ref<string | null>(null);
  const showCreateModal = ref(false);

  const searchQuery = ref("");
  type SortField = "name" | "slug" | "createdAt";
  const sortBy = ref<SortField>("name");
  const sortDir = ref<"asc" | "desc">("asc");
  const page = ref(1);
  const PAGE_SIZE = 15;

  async function fetchOrgs() {
    loading.value = true;
    try {
      const res = await fetch("/api/admin/organizations", { credentials: "include" });
      const data = (await res.json()) as { organizations: Organization[]; };
      orgs.value = data.organizations;
      page.value = 1;
    } finally {
      loading.value = false;
    }
  }

  function initials(name: string): string {
    return name
      .split(" ")
      .map((p) => p[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }

  function openOrg(id: string) {
    router.push(`/admin/organizations/${id}`);
  }

  function setSort(field: SortField) {
    if (sortBy.value === field) {
      sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
    } else {
      sortBy.value = field;
      sortDir.value = "asc";
    }
    page.value = 1;
  }

  async function deleteOrg(id: string) {
    deletingId.value = id;
    try {
      await fetch(`/api/admin/organizations/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      await fetchOrgs();
    } finally {
      deletingId.value = null;
    }
  }

  const filtered = computed(() => {
    let list = orgs.value.slice();
    const q = searchQuery.value.toLowerCase().trim();
    if (q) {
      list = list.filter(
        (o) => o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => {
      const va = a[sortBy.value]?.toLowerCase() ?? "";
      const vb = b[sortBy.value]?.toLowerCase() ?? "";
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir.value === "asc" ? cmp : -cmp;
    });
    return list;
  });

  const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)));
  const paginated = computed(() =>
    filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
  );

  onMounted(fetchOrgs);
</script>

<template>
  <div class="space-y-5">
    <!-- Header -->
    <div class="flex items-center justify-between gap-4 flex-wrap">
      <h1 class="text-2xl font-bold gradient-text">{{ t("admin.organizations") }}</h1>
      <button class="btn btn-primary" @click="showCreateModal = true">
        <Plus class="w-4 h-4" />
        {{ t("admin.newOrganization") }}
      </button>
    </div>

    <!-- Search -->
    <div class="relative" style="max-width: 360px">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
        style="color: var(--color-text-muted)" />
      <input v-model="searchQuery" type="text" :placeholder="t('common.search')" class="input pl-9"
        @input="page = 1" />
    </div>

    <!-- Loading -->
    <div v-if="loading" class="card text-center py-12" style="color: var(--color-text-muted)">
      {{ t("common.loading") }}
    </div>

    <!-- Table -->
    <div v-else class="card !p-0 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr style="border-bottom: 1px solid var(--color-border)">
              <th class="text-left px-4 py-3 cursor-pointer select-none"
                style="color: var(--color-text-muted)" @click="setSort('name')">
                <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                  {{ t("common.name") }}
                  <ChevronsUpDown v-if="sortBy !== 'name'" class="w-3 h-3 opacity-40" />
                  <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                  <ChevronDown v-else class="w-3 h-3" />
                </span>
              </th>
              <th class="text-left px-4 py-3 cursor-pointer select-none hidden sm:table-cell"
                style="color: var(--color-text-muted)" @click="setSort('slug')">
                <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                  {{ t("admin.orgSlug") }}
                  <ChevronsUpDown v-if="sortBy !== 'slug'" class="w-3 h-3 opacity-40" />
                  <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                  <ChevronDown v-else class="w-3 h-3" />
                </span>
              </th>
              <th class="text-left px-4 py-3 cursor-pointer select-none hidden md:table-cell"
                style="color: var(--color-text-muted)" @click="setSort('createdAt')">
                <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                  Created
                  <ChevronsUpDown v-if="sortBy !== 'createdAt'" class="w-3 h-3 opacity-40" />
                  <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                  <ChevronDown v-else class="w-3 h-3" />
                </span>
              </th>
              <th class="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="org in paginated" :key="org.id"
              class="transition-colors hover:bg-[--bg-secondary] cursor-pointer"
              style="border-bottom: 1px solid var(--color-border)" @click="openOrg(org.id)">
              <!-- Name + logo -->
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  <img v-if="org.logo" :src="org.logo" :alt="org.name"
                    class="w-8 h-8 rounded-lg object-cover shrink-0" />
                  <div v-else
                    class="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold font-mono shrink-0"
                    style="background: var(--color-primary-light); color: var(--color-primary)">
                    {{ initials(org.name) }}
                  </div>
                  <span class="font-medium truncate">{{ org.name }}</span>
                </div>
              </td>
              <!-- Slug -->
              <td class="px-4 py-3 hidden sm:table-cell">
                <code class="text-xs font-mono" style="color: var(--color-text-muted)">{{ org.slug }}</code>
              </td>
              <!-- Created -->
              <td class="px-4 py-3 hidden md:table-cell text-sm" style="color: var(--color-text-muted)">
                {{ new Date(org.createdAt).toLocaleDateString() }}
              </td>
              <!-- Actions -->
              <td class="px-4 py-3">
                <div class="flex items-center gap-1 justify-end">
                  <button class="btn btn-ghost p-1.5" :title="t('common.delete')"
                    :disabled="deletingId === org.id"
                    @click.stop="deleteOrg(org.id)">
                    <Trash2 class="w-4 h-4" style="color: #f87171" />
                  </button>
                </div>
              </td>
            </tr>

            <tr v-if="paginated.length === 0">
              <td colspan="4" class="px-4 py-12 text-center">
                <p class="text-sm" style="color: var(--color-text-muted)">
                  {{ filtered.length === 0 && orgs.length > 0
                    ? "No results for this search."
                    : t("admin.noOrganizations") }}
                </p>
                <button v-if="orgs.length === 0" class="btn btn-primary mt-4" @click="showCreateModal = true">
                  <Plus class="w-4 h-4" />
                  {{ t("admin.newOrganization") }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="flex items-center justify-between px-4 py-3"
        style="border-top: 1px solid var(--color-border)">
        <span class="text-xs" style="color: var(--color-text-muted)">
          {{ (page - 1) * PAGE_SIZE + 1 }}–{{ Math.min(page * PAGE_SIZE, filtered.length) }}
          de {{ filtered.length }}
        </span>
        <div class="flex items-center gap-2">
          <button class="btn btn-ghost p-1.5" :disabled="page === 1" @click="page--">
            <ChevronLeft class="w-4 h-4" />
          </button>
          <span class="text-sm font-medium px-1">{{ page }} / {{ totalPages }}</span>
          <button class="btn btn-ghost p-1.5" :disabled="page >= totalPages" @click="page++">
            <ChevronRight class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>

    <OrgCreateModal :open="showCreateModal" @close="showCreateModal = false"
      @created="showCreateModal = false; fetchOrgs()" />
  </div>
</template>
