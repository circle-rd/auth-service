import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Organization, OrganizationMember } from '@/types';
import * as orgsApi from '@/api/organizations';
import { ApiError } from '@/api/client';

export const useOrganizationsStore = defineStore('organizations', () => {
  const organizations = ref<Organization[]>([]);
  const orgMembers = ref<Record<string, OrganizationMember[]>>({});
  const membersLoading = ref<Record<string, boolean>>({});
  const orgMemberTotals = ref<Record<string, number>>({});
  const orgMembersLoadingMore = ref<Record<string, boolean>>({});
  const loading = ref(false);
  const error = ref<ApiError | null>(null);
  const total = ref(0);
  const page = ref(1);
  const limit = ref(20);
  const search = ref('');
  const sortBy = ref<'name' | 'slug' | 'createdAt'>('name');
  const sortOrder = ref<'asc' | 'desc'>('asc');

  async function fetchOrganizations(params?: Partial<{
    page: number; limit: number; search: string;
    sortBy: 'name' | 'slug' | 'createdAt'; sortOrder: 'asc' | 'desc';
  }>) {
    if (params?.page !== undefined) page.value = params.page;
    if (params?.limit !== undefined) limit.value = params.limit;
    if (params?.search !== undefined) search.value = params.search;
    if (params?.sortBy !== undefined) sortBy.value = params.sortBy;
    if (params?.sortOrder !== undefined) sortOrder.value = params.sortOrder;

    loading.value = true;
    error.value = null;
    try {
      const res = await orgsApi.listOrganizations({
        page: page.value,
        limit: limit.value,
        search: search.value || undefined,
        sortBy: sortBy.value,
        sortOrder: sortOrder.value,
      });
      organizations.value = res.organizations;
      total.value = res.total;
    } catch (err) {
      error.value = err instanceof ApiError ? err : new ApiError('UNKNOWN', 'Failed to load organizations');
    } finally {
      loading.value = false;
    }
  }

  async function fetchOrgMembers(
    orgId: string,
    opts: { offset?: number; limit?: number; append?: boolean } = {},
  ) {
    const loadingKey = opts.append ? orgMembersLoadingMore : membersLoading;
    loadingKey.value = { ...loadingKey.value, [orgId]: true };
    try {
      const offset = opts.offset ?? 0;
      const res = await orgsApi.listOrganizationMembers(orgId, {
        limit: opts.limit ?? 20,
        offset,
      });
      const existing = opts.append ? orgMembers.value[orgId] ?? [] : [];
      const merged = [...existing];
      for (const member of res.members) {
        if (!merged.some((m) => m.id === member.id)) merged.push(member);
      }
      orgMembers.value = { ...orgMembers.value, [orgId]: merged };
      orgMemberTotals.value = { ...orgMemberTotals.value, [orgId]: res.total };
    } finally {
      loadingKey.value = { ...loadingKey.value, [orgId]: false };
    }
  }

  async function loadMoreOrgMembers(orgId: string, limit = 20) {
    const current = orgMembers.value[orgId] ?? [];
    await fetchOrgMembers(orgId, { offset: current.length, limit, append: true });
  }

  async function deleteOrganization(id: string) {
    await orgsApi.deleteOrganization(id);
    organizations.value = organizations.value.filter(o => o.id !== id);
    total.value = Math.max(0, total.value - 1);
  }

  return {
    organizations, orgMembers, membersLoading, orgMembersLoadingMore, orgMemberTotals,
    loading, error, total, page, limit, search, sortBy, sortOrder,
    fetchOrganizations, fetchOrgMembers, loadMoreOrgMembers, deleteOrganization,
  };
});
