import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const routes = [
  { path: '/', redirect: '/profile' },
  {
    path: '/dashboard',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/users',
    name: 'users',
    component: () => import('@/views/UsersView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/users/:id',
    name: 'user-detail',
    component: () => import('@/views/UserDetailView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/organizations',
    name: 'organizations',
    component: () => import('@/views/OrganizationsView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/applications',
    name: 'applications',
    component: () => import('@/views/ApplicationsView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/applications/:id',
    name: 'application-detail',
    component: () => import('@/views/ApplicationDetailView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/configuration',
    name: 'configuration',
    component: () => import('@/views/ConfigurationView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/profile',
    name: 'profile',
    component: () => import('@/views/ProfileView.vue'),
    meta: { requiresAdmin: false },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { requiresAdmin: false, isPublic: true },
  },
  {
    path: '/forgot-password',
    name: 'forgot-password',
    component: () => import('@/views/ForgotPasswordView.vue'),
    meta: { requiresAdmin: false, isPublic: true },
  },
  {
    // Two entry shapes reach this view:
    //  - the e-mailed link is `…/api/auth/reset-password/<token>?callbackURL=`,
    //    and BetterAuth's callback redirects to `callbackURL?token=<token>`;
    //  - a direct `/reset-password/<token>` link, which the server's SPA
    //    fallback serves.
    // The token therefore arrives in the query for the first shape, in the
    // path for the second, and is optional here.
    path: '/reset-password/:token?',
    name: 'reset-password',
    component: () => import('@/views/ResetPasswordView.vue'),
    meta: { requiresAdmin: false, isPublic: true },
  },
  {
    path: '/oauth2/consent',
    name: 'consent',
    component: () => import('@/views/ConsentView.vue'),
    meta: { requiresAdmin: false },
  },
  {
    path: '/device',
    name: 'device',
    component: () => import('@/views/DeviceView.vue'),
    meta: { requiresAdmin: false },
  },
  {
    path: '/forbidden',
    name: 'forbidden',
    component: () => import('@/views/ForbiddenView.vue'),
    meta: { requiresAdmin: false, isPublic: true },
  },
  {
    // Post-verification landing page. Public by design: the verification click
    // no longer opens a session, so this view must render for an anonymous
    // visitor and must never bounce to a protected area. Which flow completed
    // travels in `?status=`.
    path: '/email-verified',
    name: 'email-verified',
    component: () => import('@/views/EmailVerifiedView.vue'),
    meta: { requiresAdmin: false, isPublic: true, skipSessionFetch: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { requiresAdmin: false, isPublic: true },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // The confirmation page must render for an anonymous visitor without asking
  // the API who they are: it is the post-verification landing, and the whole
  // point of the flow is that the click did not create a session.
  if (to.meta.skipSessionFetch === true) {
    return true;
  }

  if (!auth.initialized) {
    await auth.fetchSession();
  }

  const isPublic = to.meta.isPublic === true;

  if (!auth.user && !isPublic) {
    return { name: 'login' };
  }

  if (auth.user && to.meta.requiresAdmin && !auth.isAdmin()) {
    return { name: 'forbidden' };
  }

  return true;
});

export default router;
