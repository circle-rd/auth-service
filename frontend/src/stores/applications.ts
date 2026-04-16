import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Application } from '@/types';
import * as appsApi from '@/api/applications';
import { ApiError } from '@/api/client';

export const useApplicationsStore = defineStore('applications', () => {
  const applications = ref<Application[]>([]);
  const loading = ref(false);
  const error = ref<ApiError | null>(null);

  async function fetchApplications() {
    loading.value = true;
    error.value = null;
    try {
      const res = await appsApi.listApplications();
      applications.value = res.applications;
    } catch (err) {
      error.value = err instanceof ApiError ? err : new ApiError('UNKNOWN', 'Failed to load applications');
    } finally {
      loading.value = false;
    }
  }

  async function deleteApplication(id: string) {
    await appsApi.deleteApplication(id);
    applications.value = applications.value.filter(a => a.id !== id);
  }

  async function updateApplication(id: string, body: Partial<appsApi.CreateApplicationBody>) {
    const res = await appsApi.updateApplication(id, body);
    const idx = applications.value.findIndex(a => a.id === id);
    if (idx >= 0) applications.value[idx] = res.application;
  }

  return { applications, loading, error, fetchApplications, deleteApplication, updateApplication };
});
