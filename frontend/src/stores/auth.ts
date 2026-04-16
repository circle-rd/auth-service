import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { User, Session } from '@/types';
import { getSession, signOut as apiSignOut } from '@/api/auth';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const session = ref<Session | null>(null);
  const loading = ref(false);
  const initialized = ref(false);

  async function fetchSession() {
    loading.value = true;
    try {
      const result = await getSession();
      if (result) {
        user.value = result.user;
        session.value = result.session;
      } else {
        user.value = null;
        session.value = null;
      }
    } catch {
      user.value = null;
      session.value = null;
    } finally {
      loading.value = false;
      initialized.value = true;
    }
  }

  async function logout() {
    try {
      await apiSignOut();
    } catch {
      // proceed even if API fails (e.g. session already expired)
    }
    user.value = null;
    session.value = null;
  }

  function isAdmin(): boolean {
    return user.value?.role === 'admin' || user.value?.role === 'superadmin';
  }

  function isSuperAdmin(): boolean {
    return user.value?.role === 'superadmin';
  }

  return { user, session, loading, initialized, fetchSession, logout, isAdmin, isSuperAdmin };
});
