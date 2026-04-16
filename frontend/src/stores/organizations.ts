import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Organization } from '@/types';
import * as orgsApi from '@/api/organizations';
import { ApiError } from '@/api/client';

export const useOrganizationsStore = defineStore('organizations', () => {
  const organizations = ref<Organization[]>([]);
  const loading = ref(false);
  const error = ref<ApiError | null>(null);

  async function fetchOrganizations() {
    loading.value = true;
    error.value = null;
    try {
      const res = await orgsApi.listOrganizations();
      organizations.value = res.organizations;
    } catch (err) {
      error.value = err instanceof ApiError ? err : new ApiError('UNKNOWN', 'Failed to load organizations');
    } finally {
      loading.value = false;
    }
  }

  async function deleteOrganization(id: string) {
    await orgsApi.deleteOrganization(id);
    organizations.value = organizations.value.filter(o => o.id !== id);
  }

  return { organizations, loading, error, fetchOrganizations, deleteOrganization };
});
