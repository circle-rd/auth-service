import { defineStore } from "pinia";
import { ref, computed } from "vue";

interface User {
  id: string;
  email: string;
  name: string;
  role?: string;
  image?: string | null;
  emailVerified?: boolean;
  createdAt?: string;
  phone?: string | null;
  company?: string | null;
  position?: string | null;
  address?: string | null;
}

interface Session {
  user: User;
  session: {
    id: string;
    expiresAt: string;
  };
}

export const useAuthStore = defineStore("auth", () => {
  const session = ref<Session | null>(null);
  const initialized = ref(false);
  const loading = ref(false);

  const isAuthenticated = computed(() => session.value !== null);
  const user = computed(() => session.value?.user ?? null);

  async function fetchSession(): Promise<void> {
    loading.value = true;
    try {
      const res = await fetch("/api/auth/get-session", {
        credentials: "include",
      });
      if (res.ok) {
        session.value = (await res.json()) as Session;
      } else {
        session.value = null;
      }
    } catch {
      session.value = null;
    } finally {
      loading.value = false;
      initialized.value = true;
    }
  }

  async function signIn(email: string, password: string): Promise<void> {
    const res = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    const data = (await res.json()) as
      | Session
      | { twoFactorRequired: boolean }
      | { error: { code: string; message: string } };

    if (!res.ok) {
      const err = data as { error: { code: string; message: string } };
      throw new Error(err.error?.message ?? "Sign-in failed");
    }

    if ("twoFactorRequired" in data && data.twoFactorRequired) {
      // Redirect to MFA screen — router guard will handle this
      throw new Error("MFA_REQUIRED");
    }

    session.value = data as Session;
  }

  async function signOut(): Promise<void> {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
    });
    session.value = null;
  }

  async function register(
    email: string,
    password: string,
    name: string,
  ): Promise<void> {
    const res = await fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password, name }),
    });
    const data = (await res.json()) as
      | Session
      | { error: { code: string; message: string } };
    if (!res.ok) {
      const err = data as { error: { code: string; message: string } };
      throw new Error(err.error?.message ?? "Registration failed");
    }
    session.value = data as Session;
  }

  return {
    session,
    initialized,
    loading,
    isAuthenticated,
    user,
    fetchSession,
    signIn,
    signOut,
    register,
  };
});
