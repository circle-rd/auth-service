import type { Component } from 'vue';

/**
 * Column definition for the shared DataTable component.
 *
 * - `key`: stable identifier; matches the named slot `cell-<key>` if a
 *   custom cell renderer is provided.
 * - `field`: dot-path accessor on the row object used for default text
 *   rendering and client-side sort. Optional when `cell-<key>` slot is used.
 * - `responsive`: Tailwind responsive prefix that controls visibility — the
 *   column is hidden below the breakpoint (e.g. `md` hides on mobile).
 * - `align`: cell alignment; default `left`.
 * - `sortable`: enables the sort caret in the header.
 * - `width`: optional fixed width class (e.g. `w-32`, `w-[180px]`).
 * - `hidden`: column-visibility toggle; managed by the table when the
 *   visibility dropdown is rendered, or controlled externally.
 */
export interface ColumnDef<Row = Record<string, unknown>> {
  key: string;
  label: string;
  field?: string;
  responsive?: 'sm' | 'md' | 'lg' | 'xl';
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  width?: string;
  hidden?: boolean;
  icon?: Component;
  /**
   * Optional value extractor used by client-side sort and default text
   * rendering when no `cell-<key>` slot is provided. Receives the full row.
   */
  accessor?: (row: Row) => unknown;
}

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  direction: SortDirection;
}
