import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { User } from '@/types';
import * as usersApi from '@/api/users';
import { ApiError } from '@/api/client';

export const useUsersStore = defineStore('users', () => {
  const users = ref<User[]>([]);
  const total = ref(0);
  const page = ref(1);
  const limit = ref(20);
  const loading = ref(false);
  const error = ref<ApiError | null>(null);

  async function fetchUsers(params: { page?: number; limit?: number; search?: string } = {}) {
    loading.value = true;
    error.value = null;
    try {
      const res = await usersApi.listUsers(params);
      users.value = res.users;
      total.value = res.total;
      page.value = res.page;
      limit.value = res.limit;
    } catch (err) {
      error.value = err instanceof ApiError ? err : new ApiError('UNKNOWN', 'Failed to load users');
    } finally {
      loading.value = false;
    }
  }

  async function deleteUser(id: string) {
    await usersApi.deleteUser(id);
    users.value = users.value.filter(u => u.id !== id);
    total.value = Math.max(0, total.value - 1);
  }

  async function updateUser(id: string, body: usersApi.UpdateUserBody) {
    await usersApi.updateUser(id, body);
    const idx = users.value.findIndex(u => u.id === id);
    if (idx >= 0) Object.assign(users.value[idx], body, { updatedAt: new Date().toISOString() });
  }

  return { users, total, page, limit, loading, error, fetchUsers, deleteUser, updateUser };
});
