import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Organization, OrganizationMember } from '@/types';
import * as orgsApi from '@/api/organizations';
import { ApiError } from '@/api/client';

export const useOrganizationsStore = defineStore('organizations', () => {
  const organizations = ref<Organization[]>([]);
  const orgMembers = ref<Record<string, OrganizationMember[]>>({});
  const membersLoading = ref<Record<string, boolean>>({});
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

  async function fetchOrgMembers(orgId: string) {
    membersLoading.value = { ...membersLoading.value, [orgId]: true };
    try {
      const res = await orgsApi.listOrganizationMembers(orgId, { limit: 100 });
      orgMembers.value = { ...orgMembers.value, [orgId]: res.members };
    } finally {
      membersLoading.value = { ...membersLoading.value, [orgId]: false };
    }
  }

  async function deleteOrganization(id: string) {
    await orgsApi.deleteOrganization(id);
    organizations.value = organizations.value.filter(o => o.id !== id);
    total.value = Math.max(0, total.value - 1);
  }

  return {
    organizations, orgMembers, membersLoading, loading, error,
    total, page, limit, search, sortBy, sortOrder,
    fetchOrganizations, fetchOrgMembers, deleteOrganization,
  };
});
