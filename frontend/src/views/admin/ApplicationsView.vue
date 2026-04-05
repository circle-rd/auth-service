<script setup lang="ts">
  import { ref, computed, onMounted } from "vue";
  import { useI18n } from "vue-i18n";
  import { useRouter } from "vue-router";
  import { Plus, Search, ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight } from "lucide-vue-next";
  import AppDeleteModal from "../../components/admin/AppDeleteModal.vue";
  import AppCreateModal from "../../components/admin/AppCreateModal.vue";
  import { Trash2 } from "lucide-vue-next";

  const { t } = useI18n();
  const router = useRouter();

  interface Application {
    id: string;
    name: string;
    slug: string;
    icon?: string | null;
    isActive: boolean;
    createdAt: string;
  }

  const apps = ref<Application[]>([]);
  const loading = ref(false);

  // Modal state
  const showCreateModal = ref(false);
  const deleteApp = ref<{ id: string; name: string; } | null>(null);

  function openApp(id: string) {
    router.push(`/admin/applications/${id}`);
  }

  // Search & filter
  const searchQuery = ref("");
  const statusFilter = ref<"all" | "active" | "inactive">("all");

  // Sort
  type SortField = "name" | "slug" | "status" | "createdAt";
  const sortBy = ref<SortField>("name");
  const sortDir = ref<"asc" | "desc">("asc");

  // Pagination
  const page = ref(1);
  const PAGE_SIZE = 15;

  async function fetchApps() {
    loading.value = true;
    try {
      const res = await fetch("/api/admin/applications", { credentials: "include" });
      const data = (await res.json()) as { applications: Application[]; };
      apps.value = data.applications;
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

  function setSort(field: SortField) {
    if (sortBy.value === field) {
      sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
    } else {
      sortBy.value = field;
      sortDir.value = "asc";
    }
    page.value = 1;
  }

  const filtered = computed(() => {
    let list = apps.value.slice();

    // Status filter
    if (statusFilter.value === "active") list = list.filter((a) => a.isActive);
    else if (statusFilter.value === "inactive") list = list.filter((a) => !a.isActive);

    // Search
    const q = searchQuery.value.toLowerCase().trim();
    if (q) {
      list = list.filter(
        (a) => a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q),
      );
    }

    // Sort
    list.sort((a, b) => {
      let va: string, vb: string;
      if (sortBy.value === "status") {
        va = a.isActive ? "1" : "0";
        vb = b.isActive ? "1" : "0";
      } else if (sortBy.value === "createdAt") {
        va = a.createdAt;
        vb = b.createdAt;
      } else {
        va = a[sortBy.value].toLowerCase();
        vb = b[sortBy.value].toLowerCase();
      }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir.value === "asc" ? cmp : -cmp;
    });

    return list;
  });

  const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)));
  const paginated = computed(() =>
    filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
  );

  onMounted(fetchApps);
</script>

<template>
  <div class="space-y-5">
    <!-- Page header -->
    <div class="flex items-center justify-between gap-4 flex-wrap">
      <h1 class="text-2xl font-bold gradient-text">{{ t("admin.applications") }}</h1>
      <button class="btn btn-primary" @click="showCreateModal = true">
        <Plus class="w-4 h-4" />
        {{ t("admin.createApp") }}
      </button>
    </div>

    <!-- Toolbar: search + filter -->
    <div class="flex flex-wrap items-center gap-3">
      <div class="relative flex-1" style="min-width: 200px; max-width: 360px">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
          style="color: var(--color-text-muted)" />
        <input v-model="searchQuery" type="text" :placeholder="t('common.search')" class="input pl-9"
          @input="page = 1" />
      </div>
      <div class="flex items-center gap-1 rounded-lg p-0.5"
        style="background: var(--color-bg); border: 1px solid var(--color-border)">
        <button
          v-for="opt in [{ val: 'all', label: 'Tous' }, { val: 'active', label: t('common.active') }, { val: 'inactive', label: t('common.inactive') }]"
          :key="opt.val" class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors" :style="statusFilter === opt.val
            ? 'background: var(--color-surface); color: var(--color-text); box-shadow: 0 1px 2px rgba(0,0,0,0.1)'
            : 'color: var(--color-text-muted)'" @click="statusFilter = opt.val as typeof statusFilter; page = 1">
          {{ opt.label }}
        </button>
      </div>
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
              <!-- Slug -->
              <th class="text-left px-4 py-3 cursor-pointer select-none hidden sm:table-cell"
                style="color: var(--color-text-muted)" @click="setSort('slug')">
                <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                  {{ t("admin.appSlug") }}
                  <ChevronsUpDown v-if="sortBy !== 'slug'" class="w-3 h-3 opacity-40" />
                  <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                  <ChevronDown v-else class="w-3 h-3" />
                </span>
              </th>
              <!-- Status -->
              <th class="text-left px-4 py-3 cursor-pointer select-none" style="color: var(--color-text-muted)"
                @click="setSort('status')">
                <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                  {{ t("common.status") }}
                  <ChevronsUpDown v-if="sortBy !== 'status'" class="w-3 h-3 opacity-40" />
                  <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                  <ChevronDown v-else class="w-3 h-3" />
                </span>
              </th>
              <!-- Created at -->
              <th class="text-left px-4 py-3 cursor-pointer select-none hidden md:table-cell"
                style="color: var(--color-text-muted)" @click="setSort('createdAt')">
                <span class="flex items-center gap-1.5 text-xs uppercase tracking-wide font-medium">
                  Created
                  <ChevronsUpDown v-if="sortBy !== 'createdAt'" class="w-3 h-3 opacity-40" />
                  <ChevronUp v-else-if="sortDir === 'asc'" class="w-3 h-3" />
                  <ChevronDown v-else class="w-3 h-3" />
                </span>
              </th>
              <!-- Actions -->
              <th class="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="app in paginated" :key="app.id"
              class="transition-colors hover:bg-[--bg-secondary] cursor-pointer"
              style="border-bottom: 1px solid var(--color-border)" @click="openApp(app.id)">
              <!-- Name + icon -->
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  <img v-if="app.icon" :src="app.icon" :alt="app.name"
                    class="w-8 h-8 rounded-lg object-cover shrink-0" />
                  <div v-else
                    class="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold font-mono shrink-0"
                    style="background: var(--color-primary-light); color: var(--color-primary)">
                    {{ initials(app.name) }}
                  </div>
                  <span class="font-medium truncate">{{ app.name }}</span>
                </div>
              </td>
              <!-- Slug -->
              <td class="px-4 py-3 hidden sm:table-cell">
                <code class="text-xs font-mono" style="color: var(--color-text-muted)">{{ app.slug }}</code>
              </td>
              <!-- Status -->
              <td class="px-4 py-3">
                <span class="badge" :class="app.isActive ? 'badge-success' : 'badge-inactive'">
                  {{ app.isActive ? t("common.active") : t("common.inactive") }}
                </span>
              </td>
              <!-- Created -->
              <td class="px-4 py-3 hidden md:table-cell text-sm" style="color: var(--color-text-muted)">
                {{ new Date(app.createdAt).toLocaleDateString() }}
              </td>
              <!-- Actions -->
              <td class="px-4 py-3">
                <div class="flex items-center gap-1 justify-end">
                  <button class="btn btn-ghost p-1.5" :title="t('common.delete')"
                    @click.stop="deleteApp = { id: app.id, name: app.name }">
                    <Trash2 class="w-4 h-4" style="color: #f87171" />
                  </button>
                </div>
              </td>
            </tr>

            <!-- Empty state -->
            <tr v-if="paginated.length === 0">
              <td colspan="5" class="px-4 py-12 text-center">
                <p class="text-sm" style="color: var(--color-text-muted)">
                  {{ filtered.length === 0 && apps.length > 0 ? 'No results for this search.' : 'No applications yet.'
                  }}
                </p>
                <button v-if="apps.length === 0" class="btn btn-primary mt-4" @click="showCreateModal = true">
                  <Plus class="w-4 h-4" />
                  {{ t("admin.createApp") }}
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

    <!-- Create modal -->
    <AppCreateModal :open="showCreateModal" @close="showCreateModal = false"
      @created="showCreateModal = false; fetchApps()" />

    <!-- Edit modal removed: rows now navigate to ApplicationDetailView -->

    <!-- Delete modal -->
    <AppDeleteModal v-if="deleteApp" :app-id="deleteApp.id" :app-name="deleteApp.name" :open="!!deleteApp"
      @confirm="deleteApp = null; fetchApps()" @cancel="deleteApp = null" />
  </div>
</template>
