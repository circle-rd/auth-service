import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth.js";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    // Public
    {
      path: "/login",
      component: () => import("../views/LoginView.vue"),
      meta: { public: true },
    },
    {
      path: "/register",
      component: () => import("../views/RegisterView.vue"),
      meta: { public: true },
    },
    {
      path: "/forgot-password",
      component: () => import("../views/ForgotPasswordView.vue"),
      meta: { public: true },
    },
    {
      path: "/reset-password",
      component: () => import("../views/ResetPasswordView.vue"),
      meta: { public: true },
    },
    {
      path: "/verify-mfa",
      component: () => import("../views/MfaVerifyView.vue"),
      meta: { public: true },
    },
    {
      path: "/oauth2/consent",
      component: () => import("../views/ConsentView.vue"),
      meta: { public: true },
    },

    // Protected — User
    {
      path: "/",
      redirect: "/admin",
    },
    {
      path: "/profile",
      component: () => import("../views/ProfileLayout.vue"),
      children: [
        { path: "", component: () => import("../views/ProfileView.vue") },
        {
          path: "mfa",
          component: () => import("../views/MfaSettingsView.vue"),
        },
        {
          path: "sessions",
          component: () => import("../views/SessionsView.vue"),
        },
        {
          path: "subscription",
          component: () => import("../views/SubscriptionView.vue"),
        },
      ],
    },

    // Admin
    {
      path: "/admin",
      component: () => import("../views/admin/AdminLayout.vue"),
      meta: { requireAdmin: true },
      children: [
        {
          path: "",
          redirect: "/admin/dashboard",
        },
        {
          path: "dashboard",
          component: () => import("../views/admin/DashboardView.vue"),
        },
        {
          path: "users",
          component: () => import("../views/admin/UsersView.vue"),
        },
        {
          path: "users/:id",
          component: () => import("../views/admin/UserDetailView.vue"),
        },
        {
          path: "organizations",
          component: () => import("../views/admin/OrganizationsView.vue"),
        },
        {
          path: "organizations/:id",
          component: () => import("../views/admin/OrganizationDetailView.vue"),
        },
        {
          path: "applications",
          component: () => import("../views/admin/ApplicationsView.vue"),
        },
        {
          path: "applications/:id",
          component: () => import("../views/admin/ApplicationDetailView.vue"),
        },
        {
          path: "applications/:id/roles",
          component: () => import("../views/admin/AppRolesView.vue"),
        },
        {
          path: "applications/:id/plans",
          component: () => import("../views/admin/AppPlansView.vue"),
        },
        {
          path: "applications/:id/users",
          component: () => import("../views/admin/AppUsersView.vue"),
        },
        {
          path: "applications/:id/usage",
          component: () => import("../views/admin/AppUsageView.vue"),
        },
        {
          path: "applications/:id/integration",
          component: () => import("../views/admin/AppIntegrationView.vue"),
        },
      ],
    },

    // Fallback
    {
      path: "/:pathMatch(.*)*",
      redirect: "/login",
    },
  ],
});

router.beforeEach(async (to) => {
  const authStore = useAuthStore();

  if (!authStore.initialized) {
    await authStore.fetchSession();
  }

  if (!to.meta.public && !authStore.isAuthenticated) {
    return { path: "/login", query: { redirectTo: to.fullPath } };
  }

  if (to.meta.requireAdmin) {
    const role = authStore.user?.role as string | undefined;
    if (role !== "admin" && role !== "superadmin") {
      return { path: "/profile" };
    }
  }
});
