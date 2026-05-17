<script setup lang="ts" generic="Row extends Record<string, unknown>">
import { computed, ref, watch } from 'vue';
import { ChevronUp, ChevronDown, ChevronsUpDown, Columns3, Rows3, Rows4, Search, ChevronLeft, ChevronRight } from 'lucide-vue-next';
import { useI18n } from 'vue-i18n';
import type { ColumnDef, DataTablePagination, SortState } from '@/types/data-table';

const props = withDefaults(defineProps<{
  /** Optional column-driven mode. When provided, the table auto-renders headers and rows. */
  columns?: ColumnDef<Row>[];
  /** Row data — required when `columns` is provided. */
  items?: Row[];
  /** Stable row key accessor. */
  rowKey?: (row: Row) => string | number;
  /** When true, shows a shimmering skeleton body. */
  loading?: boolean;
  /** When true (and not loading), shows the `empty` slot. */
  empty?: boolean;
  /** Number of skeleton rows when loading. */
  skeletonRows?: number;
  /**
   * Number of skeleton columns. Defaults to `columns.length` when column
   * mode is active and to 4 otherwise (legacy slot mode).
   */
  skeletonCols?: number;
  /** Controlled sort state. Omit for uncontrolled internal sort. */
  sort?: SortState | null;
  /** Show the built-in toolbar above the table when the toolbar slot is used. */
  toolbar?: boolean;
  /** Allow users to toggle column visibility (built-in dropdown). */
  enableColumnVisibility?: boolean;
  /** Allow users to switch between comfortable and compact row density. */
  enableDensityToggle?: boolean;
  /** Render the built-in search input (bound through `v-model:search`). */
  searchable?: boolean;
  /** Current search string. Use with `v-model:search` for two-way binding. */
  search?: string;
  /** Placeholder shown in the search input. Defaults to the i18n `common.search` label. */
  searchPlaceholder?: string;
  /**
   * Server-driven pagination metadata. Triggers the footer with prev/next
   * controls and the rows-per-page selector. Emits `update:page` and
   * `update:limit` when the user interacts.
   */
  pagination?: DataTablePagination | null;
  /** When true, rows render with `cursor-pointer`. Pair with `@row-click`. */
  clickableRows?: boolean;
}>(), {
  loading: false,
  empty: false,
  skeletonRows: 5,
  sort: null,
  toolbar: false,
  enableColumnVisibility: false,
  enableDensityToggle: false,
  searchable: false,
  search: '',
  searchPlaceholder: '',
  pagination: null,
  clickableRows: false,
});

const emit = defineEmits<{
  (e: 'update:sort', value: SortState | null): void;
  (e: 'row-click', row: Row): void;
  (e: 'update:search', value: string): void;
  (e: 'update:page', value: number): void;
  (e: 'update:limit', value: number): void;
}>();

const { t } = useI18n();

const density = ref<'comfortable' | 'compact'>('comfortable');
function toggleDensity() {
  density.value = density.value === 'comfortable' ? 'compact' : 'comfortable';
}
const cellPaddingClass = computed(() => density.value === 'compact' ? 'px-3 py-1.5' : 'px-4 py-3');
const headerPaddingClass = computed(() => density.value === 'compact' ? 'px-3 py-2' : 'px-4 py-3');

const hiddenKeys = ref<Set<string>>(new Set(
  (props.columns ?? []).filter(c => c.hidden).map(c => c.key),
));
function toggleColumn(key: string) {
  const next = new Set(hiddenKeys.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  hiddenKeys.value = next;
}
const visibleColumns = computed(() => (props.columns ?? []).filter(c => !hiddenKeys.value.has(c.key)));
const showVisibilityMenu = ref(false);

const internalSort = ref<SortState | null>(props.sort ?? null);
watch(() => props.sort, v => { internalSort.value = v; });
const activeSort = computed<SortState | null>(() => props.sort !== undefined && props.sort !== null
  ? props.sort
  : internalSort.value);

function cycleSort(col: ColumnDef<Row>) {
  if (!col.sortable) return;
  const current = activeSort.value;
  let next: SortState | null;
  if (!current || current.key !== col.key) next = { key: col.key, direction: 'asc' };
  else if (current.direction === 'asc') next = { key: col.key, direction: 'desc' };
  else next = null;
  internalSort.value = next;
  emit('update:sort', next);
}

function readField(row: Row, field: string): unknown {
  return field.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[part];
  }, row);
}

function getCellValue(row: Row, col: ColumnDef<Row>): unknown {
  if (col.accessor) return col.accessor(row);
  if (col.field) return readField(row, col.field);
  return undefined;
}

const sortedItems = computed<Row[]>(() => {
  const items = props.items ?? [];
  const s = activeSort.value;
  if (props.sort !== null && props.sort !== undefined) return items;
  if (!s) return items;
  const col = (props.columns ?? []).find(c => c.key === s.key);
  if (!col) return items;
  const factor = s.direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = getCellValue(a, col);
    const bv = getCellValue(b, col);
    if (av === bv) return 0;
    if (av === undefined || av === null) return 1;
    if (bv === undefined || bv === null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
    return String(av).localeCompare(String(bv)) * factor;
  });
});

const colCount = computed(() => props.columns
  ? visibleColumns.value.length
  : (props.skeletonCols ?? 4));

function alignClass(col: ColumnDef<Row>): string {
  if (col.align === 'right') return 'text-right';
  if (col.align === 'center') return 'text-center';
  return 'text-left';
}

function responsiveClass(col: ColumnDef<Row>): string {
  // Static class map — Tailwind's JIT scanner only sees fully-formed class
  // names in source. Concatenating `hidden ${breakpoint}:table-cell` would
  // be silently dropped at build time, causing columns to stay hidden at
  // every viewport. Listing the literals keeps them in the generated CSS.
  if (!col.responsive) return '';
  switch (col.responsive) {
    case 'sm': return 'hidden sm:table-cell';
    case 'md': return 'hidden md:table-cell';
    case 'lg': return 'hidden lg:table-cell';
    case 'xl': return 'hidden xl:table-cell';
    case '2xl': return 'hidden 2xl:table-cell';
    default: return '';
  }
}

function defaultRowKey(row: Row, idx: number): string | number {
  if (props.rowKey) return props.rowKey(row);
  const id = (row as Record<string, unknown>).id;
  if (typeof id === 'string' || typeof id === 'number') return id;
  return idx;
}

// ── Search ─────────────────────────────────────────────────────────────
// Mirrors the `search` prop in a local ref so the input stays controllable
// even when the parent uses simple one-way binding (no v-model).
const searchValue = ref(props.search ?? '');
watch(() => props.search, (v) => { searchValue.value = v ?? ''; });
function onSearchInput(event: Event) {
  const v = (event.target as HTMLInputElement).value;
  searchValue.value = v;
  emit('update:search', v);
}

// ── Pagination ─────────────────────────────────────────────────────────
const pageCount = computed(() => {
  if (!props.pagination) return 1;
  return Math.max(1, Math.ceil(props.pagination.total / props.pagination.limit));
});
const pageStart = computed(() => {
  if (!props.pagination || props.pagination.total === 0) return 0;
  return (props.pagination.page - 1) * props.pagination.limit + 1;
});
const pageEnd = computed(() => {
  if (!props.pagination) return 0;
  return Math.min(props.pagination.total, props.pagination.page * props.pagination.limit);
});
function setPage(p: number) {
  if (!props.pagination) return;
  const next = Math.min(Math.max(1, p), pageCount.value);
  if (next !== props.pagination.page) emit('update:page', next);
}
function onLimitChange(event: Event) {
  const next = parseInt((event.target as HTMLSelectElement).value, 10);
  if (!Number.isFinite(next) || next < 1) return;
  emit('update:limit', next);
}
const defaultPageSizes = [10, 20, 50, 100];
const pageSizes = computed(() => props.pagination?.pageSizes ?? defaultPageSizes);

const showToolbar = computed(() =>
  props.toolbar
  || props.enableColumnVisibility
  || props.enableDensityToggle
  || props.searchable,
);
</script>

<template>
  <div class="space-y-3">
    <div v-if="showToolbar" class="flex items-center gap-2 flex-wrap">
      <div v-if="searchable" class="relative w-full sm:w-64 shrink-0">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" />
        <input
          type="search"
          :value="searchValue"
          @input="onSearchInput"
          :placeholder="searchPlaceholder || t('common.search')"
          class="w-full pl-9 pr-3 py-2 text-sm bg-surface-800 border border-surface-600 rounded-lg text-surface-100 placeholder:text-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500"
        />
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <slot name="filters" />
      </div>
      <div class="flex-1 min-w-0">
        <slot name="toolbar" />
      </div>
      <div v-if="enableDensityToggle" class="flex items-center">
        <button
          type="button"
          @click="toggleDensity"
          class="p-2 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-surface-800/60 transition-colors"
          :title="density === 'compact' ? 'Comfortable density' : 'Compact density'"
        >
          <component :is="density === 'compact' ? Rows4 : Rows3" class="w-4 h-4" />
        </button>
      </div>
      <div v-if="enableColumnVisibility && columns" class="relative">
        <button
          type="button"
          @click="showVisibilityMenu = !showVisibilityMenu"
          class="p-2 rounded-lg text-surface-500 hover:text-surface-300 hover:bg-surface-800/60 transition-colors"
          title="Toggle columns"
        >
          <Columns3 class="w-4 h-4" />
        </button>
        <div
          v-if="showVisibilityMenu"
          class="absolute right-0 mt-1 w-52 bg-surface-800 border border-surface-700/50 rounded-xl shadow-xl z-20 py-1"
          v-click-outside="() => (showVisibilityMenu = false)"
        >
          <label
            v-for="col in columns"
            :key="col.key"
            class="flex items-center gap-2 px-3 py-2 text-sm text-surface-300 hover:bg-surface-700/40 cursor-pointer"
          >
            <input
              type="checkbox"
              :checked="!hiddenKeys.has(col.key)"
              @change="toggleColumn(col.key)"
              class="rounded border-surface-600 bg-surface-900 text-primary-500 focus:ring-primary-500/30"
            />
            <span class="truncate">{{ col.label }}</span>
          </label>
        </div>
      </div>
    </div>

    <div class="rounded-xl overflow-hidden border border-surface-700/50 bg-surface-900/40">
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead>
            <tr class="border-b border-surface-700/50 bg-surface-800/30">
              <template v-if="columns">
                <th
                  v-for="col in visibleColumns"
                  :key="col.key"
                  :class="[
                    headerPaddingClass,
                    'text-xs font-medium text-surface-500 uppercase tracking-wide',
                    alignClass(col),
                    responsiveClass(col),
                    col.width,
                    col.sortable ? 'cursor-pointer select-none hover:text-surface-300' : '',
                  ]"
                  @click="cycleSort(col)"
                >
                  <span class="inline-flex items-center gap-1.5">
                    <component v-if="col.icon" :is="col.icon" class="w-3.5 h-3.5" />
                    <span>{{ col.label }}</span>
                    <template v-if="col.sortable">
                      <ChevronUp
                        v-if="activeSort?.key === col.key && activeSort.direction === 'asc'"
                        class="w-3.5 h-3.5"
                      />
                      <ChevronDown
                        v-else-if="activeSort?.key === col.key && activeSort.direction === 'desc'"
                        class="w-3.5 h-3.5"
                      />
                      <ChevronsUpDown v-else class="w-3.5 h-3.5 opacity-50" />
                    </template>
                  </span>
                </th>
              </template>
              <slot v-else name="head" />
            </tr>
          </thead>

          <tbody v-if="loading">
            <tr v-for="i in skeletonRows" :key="i" class="border-b border-surface-800/50 last:border-0">
              <td v-for="j in colCount" :key="j" :class="cellPaddingClass">
                <div
                  class="h-4 bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:200%_100%] animate-shimmer rounded-md"
                  :style="{ width: j === 1 ? '140px' : '90px' }"
                />
              </td>
            </tr>
          </tbody>

          <tbody v-else-if="empty || (columns && sortedItems.length === 0)">
            <tr>
              <td :colspan="colCount" class="py-0">
                <slot name="empty" />
              </td>
            </tr>
          </tbody>

          <tbody v-else-if="columns">
            <tr
              v-for="(row, idx) in sortedItems"
              :key="defaultRowKey(row, idx)"
              :class="[
                'border-b border-surface-800/50 last:border-0 hover:bg-surface-800/20 transition-colors',
                clickableRows ? 'cursor-pointer' : '',
              ]"
              @click="emit('row-click', row)"
            >
              <td
                v-for="col in visibleColumns"
                :key="col.key"
                :class="[cellPaddingClass, alignClass(col), responsiveClass(col)]"
              >
                <slot :name="`cell-${col.key}`" :row="row" :value="getCellValue(row, col)">
                  <span class="text-sm text-surface-300">{{ getCellValue(row, col) ?? '—' }}</span>
                </slot>
              </td>
            </tr>
          </tbody>

          <tbody v-else>
            <slot />
          </tbody>
        </table>
      </div>
    </div>

    <div
      v-if="pagination"
      class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm text-surface-400"
    >
      <div class="flex items-center gap-2">
        <label class="text-xs text-surface-500">{{ t('dataTable.rowsPerPage') }}</label>
        <select
          :value="pagination.limit"
          @change="onLimitChange"
          class="text-xs bg-surface-800 border border-surface-600 rounded-lg px-2 py-1 text-surface-200 focus:outline-none focus:ring-2 focus:ring-primary-500/50"
        >
          <option v-for="sz in pageSizes" :key="sz" :value="sz">{{ sz }}</option>
        </select>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-xs text-surface-500 tabular-nums">
          {{ t('dataTable.pageOf', { from: pageStart, to: pageEnd, total: pagination.total }) }}
        </span>
        <div class="flex items-center gap-1">
          <button
            type="button"
            :disabled="pagination.page <= 1"
            @click="setPage(pagination.page - 1)"
            class="p-1.5 rounded-lg text-surface-500 hover:text-surface-200 hover:bg-surface-800/60 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
            :title="t('dataTable.previous')"
          >
            <ChevronLeft class="w-4 h-4" />
          </button>
          <button
            type="button"
            :disabled="pagination.page >= pageCount"
            @click="setPage(pagination.page + 1)"
            class="p-1.5 rounded-lg text-surface-500 hover:text-surface-200 hover:bg-surface-800/60 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
            :title="t('dataTable.next')"
          >
            <ChevronRight class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
