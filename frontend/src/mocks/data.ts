import type {
  User, Session, Application, AppRole, AppPermission,
  SubscriptionPlan, UserApplication,
  Organization, ConsumptionAggregate, ServicesConfig
} from '@/types';

export const MOCK_USERS: User[] = [
  {
    id: 'usr_2wQx8mNpKvLrTbYcJdF3hA',
    name: 'Alexandre Dubois',
    email: 'alexandre.dubois@example.com',
    emailVerified: true,
    image: null,
    createdAt: '2024-01-15T09:23:11.000Z',
    updatedAt: '2024-11-02T14:05:33.000Z',
    twoFactorEnabled: true,
    role: 'superadmin',
    banned: null,
    banReason: null,
    banExpires: null,
    isMfaRequired: true,
    phone: '+33612345678',
    company: 'CIRCLE',
    position: 'Platform Engineer',
    address: '42 rue de la Paix, 75001 Paris',
    lastLoginAt: '2024-11-15T09:23:11.000Z',
    applications: [
      { id: '550e8400-e29b-41d4-a716-446655440000', name: 'Circle Dashboard', slug: 'circle-dashboard', icon: null },
      { id: '6ba7b811-9dad-11d1-80b4-00c04fd430c8', name: 'Internal API', slug: 'internal-api', icon: null },
    ],
  },
  {
    id: 'usr_5nRmW9tGxKqPsUvCeL7zBi',
    name: 'Sofia Marchetti',
    email: 'sofia.marchetti@example.com',
    emailVerified: true,
    image: null,
    createdAt: '2024-02-28T11:44:00.000Z',
    updatedAt: '2024-10-19T08:30:00.000Z',
    twoFactorEnabled: false,
    role: 'admin',
    banned: null,
    banReason: null,
    banExpires: null,
    isMfaRequired: null,
    phone: null,
    company: 'Acme Corp',
    position: 'CTO',
    address: null,
    lastLoginAt: '2024-11-14T08:21:00.000Z',
    applications: [
      { id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', name: 'Acme App', slug: 'acme-app', icon: null },
    ],
  },
  {
    id: 'usr_8jHkD4aNcOeQyMfTgX2rVo',
    name: 'Yuki Tanaka',
    email: 'yuki.tanaka@example.com',
    emailVerified: true,
    image: null,
    createdAt: '2024-04-10T16:12:00.000Z',
    updatedAt: '2024-11-01T10:00:00.000Z',
    twoFactorEnabled: false,
    role: 'user',
    banned: true,
    banReason: 'Violated terms of service',
    banExpires: '2025-01-01T00:00:00.000Z',
    isMfaRequired: null,
    phone: '+81312345678',
    company: null,
    position: null,
    address: null,
    lastLoginAt: '2024-10-22T12:08:00.000Z',
    applications: [],
  },
  {
    id: 'usr_1cEwZ6sPiLnXbQdRkA9mFu',
    name: 'Margot Lefèvre',
    email: 'margot.lefevre@example.com',
    emailVerified: false,
    image: null,
    createdAt: '2024-09-03T07:55:00.000Z',
    updatedAt: '2024-09-03T07:55:00.000Z',
    twoFactorEnabled: null,
    role: 'user',
    banned: null,
    banReason: null,
    banExpires: null,
    isMfaRequired: null,
    phone: null,
    company: 'Startup XYZ',
    position: 'Developer',
    address: null,
    lastLoginAt: null,
    applications: [
      { id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', name: 'Acme App', slug: 'acme-app', icon: null },
    ],
  },
];

export const MOCK_SESSIONS: Session[] = [
  {
    id: 'sess_3kYpT7qMnRvBsWxEjLaCo2',
    expiresAt: '2024-12-15T09:23:11.000Z',
    token: 'tok_9HjdK2LmNpQ8xRvYe5TwZ',
    createdAt: '2024-11-15T09:23:11.000Z',
    updatedAt: '2024-11-15T09:23:11.000Z',
    ipAddress: '82.64.120.45',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0',
    userId: 'usr_2wQx8mNpKvLrTbYcJdF3hA',
    impersonatedBy: null,
    activeOrganizationId: null,
    user: { id: 'usr_2wQx8mNpKvLrTbYcJdF3hA', name: 'Alexandre Dubois', email: 'alexandre.dubois@example.com', image: null },
    applications: [
      { id: '550e8400-e29b-41d4-a716-446655440000', name: 'Circle Dashboard', slug: 'circle-dashboard', icon: null },
    ],
  },
  {
    id: 'sess_6uZaS1fPkOeVdNbQlIrCg4',
    expiresAt: '2024-12-10T11:44:00.000Z',
    token: 'tok_4WrMcX8NjKqLtPeHdB6sU',
    createdAt: '2024-11-10T11:44:00.000Z',
    updatedAt: '2024-11-14T08:21:00.000Z',
    ipAddress: '91.198.174.192',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/132.0',
    userId: 'usr_5nRmW9tGxKqPsUvCeL7zBi',
    impersonatedBy: null,
    activeOrganizationId: 'org_7vBmC4dKpLqRtNsWoXeA',
    user: { id: 'usr_5nRmW9tGxKqPsUvCeL7zBi', name: 'Sofia Marchetti', email: 'sofia.marchetti@example.com', image: null },
    applications: [
      { id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', name: 'Acme App', slug: 'acme-app', icon: null },
    ],
  },
];

export const MOCK_APPLICATIONS: Application[] = [
  {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Circle Dashboard',
    slug: 'circle-dashboard',
    description: 'Main administrative dashboard for the CIRCLE platform.',
    isActive: true,
    skipConsent: true,
    isMfaRequired: true,
    allowRegister: false,
    billingMode: 'none',
    allowedScopes: ['openid', 'profile', 'email'],
    redirectUris: ['https://dashboard.circle.internal/auth/callback'],
    isPublic: false,
    isSystem: false,
    url: 'https://dashboard.circle.internal',
    allowedResources: [],
    icon: null,
    enabledSocialProviders: null,
    enableEndSession: true,
    postLogoutRedirectUris: ['https://dashboard.circle.internal/'],
    backchannelLogoutUri: null,
    backchannelLogoutSessionRequired: false,
    metadata: {},
    createdAt: '2024-01-15T10:00:00.000Z',
    updatedAt: '2024-11-01T12:00:00.000Z',
  },
  {
    id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    name: 'Acme App',
    slug: 'acme-app',
    description: 'Customer-facing application for Acme Corp.',
    isActive: true,
    skipConsent: false,
    isMfaRequired: false,
    allowRegister: true,
    billingMode: 'none',
    allowedScopes: ['openid', 'profile', 'email', 'offline_access'],
    redirectUris: ['https://app.acme.com/callback', 'http://localhost:3000/callback'],
    isPublic: true,
    isSystem: false,
    url: 'https://app.acme.com',
    allowedResources: [],
    icon: null,
    enabledSocialProviders: ['google', 'github'],
    enableEndSession: true,
    postLogoutRedirectUris: ['https://app.acme.com/'],
    backchannelLogoutUri: 'https://app.acme.com/backchannel-logout',
    backchannelLogoutSessionRequired: true,
    metadata: {},
    createdAt: '2024-03-22T14:30:00.000Z',
    updatedAt: '2024-10-15T09:45:00.000Z',
  },
  {
    id: '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
    name: 'Internal API',
    slug: 'internal-api',
    description: 'Machine-to-machine service account.',
    isActive: false,
    skipConsent: true,
    isMfaRequired: false,
    allowRegister: false,
    billingMode: 'none',
    allowedScopes: ['openid'],
    redirectUris: ['https://internal.circle.io/cb'],
    isPublic: false,
    isSystem: true,
    url: null,
    allowedResources: [],
    icon: null,
    enabledSocialProviders: [],
    enableEndSession: false,
    postLogoutRedirectUris: [],
    backchannelLogoutUri: null,
    backchannelLogoutSessionRequired: false,
    metadata: { client_kind: 'server' },
    createdAt: '2024-06-01T08:00:00.000Z',
    updatedAt: '2024-06-01T08:00:00.000Z',
  },
];

export const MOCK_ROLES: AppRole[] = [
  {
    id: 'a1b2c3d4-0001-0000-0000-000000000001',
    applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    name: 'user',
    description: 'Standard end user with read access.',
    isDefault: true,
    createdAt: '2024-03-22T14:30:01.000Z',
    permissionIds: ['p1000000-0000-0000-0000-000000000001', 'p1000000-0000-0000-0000-000000000003'],
  },
  {
    id: 'a1b2c3d4-0001-0000-0000-000000000002',
    applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    name: 'admin',
    description: 'Application administrator with full access.',
    isDefault: false,
    createdAt: '2024-03-22T14:30:01.000Z',
    permissionIds: ['p1000000-0000-0000-0000-000000000001', 'p1000000-0000-0000-0000-000000000002', 'p1000000-0000-0000-0000-000000000003', 'p1000000-0000-0000-0000-000000000004'],
  },
  {
    id: 'a1b2c3d4-0001-0000-0000-000000000003',
    applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    name: 'viewer',
    description: 'Read-only access to reports.',
    isDefault: false,
    createdAt: '2024-05-10T10:00:00.000Z',
    permissionIds: ['p1000000-0000-0000-0000-000000000003'],
  },
];

export const MOCK_PERMISSIONS: AppPermission[] = [
  { id: 'p1000000-0000-0000-0000-000000000001', applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', resource: 'documents', action: 'read', createdAt: '2024-03-22T14:30:02.000Z' },
  { id: 'p1000000-0000-0000-0000-000000000002', applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', resource: 'documents', action: 'write', createdAt: '2024-03-22T14:30:02.000Z' },
  { id: 'p1000000-0000-0000-0000-000000000003', applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', resource: 'reports', action: 'read', createdAt: '2024-04-01T09:00:00.000Z' },
  { id: 'p1000000-0000-0000-0000-000000000004', applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', resource: 'reports', action: 'write', createdAt: '2024-04-01T09:00:00.000Z' },
];

export const MOCK_PLANS: SubscriptionPlan[] = [
  {
    id: 'plan-0001-0000-0000-000000000001',
    applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    name: 'free',
    description: 'Free tier with basic access.',
    stripeProductId: null,
    features: { maxProjects: 3, apiCallsPerMonth: 1000, supportLevel: 'community' },
    isDefault: true,
    createdAt: '2024-03-22T14:30:03.000Z',
    updatedAt: '2024-03-22T14:30:03.000Z',
    prices: [],
  },
  {
    id: 'plan-0001-0000-0000-000000000002',
    applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    name: 'pro',
    description: 'Professional plan for growing teams.',
    stripeProductId: 'prod_QxBkR3fMnLpT7yJw',
    features: { maxProjects: 50, apiCallsPerMonth: 100000, supportLevel: 'email', customDomain: true },
    isDefault: false,
    createdAt: '2024-03-22T14:30:03.000Z',
    updatedAt: '2024-09-01T10:00:00.000Z',
    prices: [
      { id: 'price-0001-0000-0000-000000000001', planId: 'plan-0001-0000-0000-000000000002', name: 'Pro Monthly', amount: '2900', currency: 'eur', interval: 'month', billingType: 'fixed', featureKey: null, unit: null, usageLimit: null, stripePriceId: 'price_HkMnO8pQrStUvWxY', createdAt: '2024-03-22T14:30:04.000Z' },
      { id: 'price-0001-0000-0000-000000000002', planId: 'plan-0001-0000-0000-000000000002', name: 'Pro Annual', amount: '29000', currency: 'eur', interval: 'year', billingType: 'fixed', featureKey: null, unit: null, usageLimit: null, stripePriceId: 'price_AaBbCcDdEeFfGgHh', createdAt: '2024-03-22T14:30:04.000Z' },
    ],
  },
  {
    id: 'plan-0001-0000-0000-000000000003',
    applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    name: 'enterprise',
    description: 'Unlimited usage with dedicated support and SLA.',
    stripeProductId: 'prod_EnTeRpRiSePrOd',
    features: { maxProjects: -1, apiCallsPerMonth: -1, supportLevel: 'dedicated', sla: '99.99%', customDomain: true, sso: true },
    isDefault: false,
    createdAt: '2024-05-01T00:00:00.000Z',
    updatedAt: '2024-05-01T00:00:00.000Z',
    prices: [
      { id: 'price-0001-0000-0000-000000000003', planId: 'plan-0001-0000-0000-000000000003', name: 'Enterprise Annual', amount: '120000', currency: 'eur', interval: 'year', billingType: 'fixed', featureKey: null, unit: null, usageLimit: null, stripePriceId: null, createdAt: '2024-05-01T00:00:00.000Z' },
    ],
  },
];

export const MOCK_ORGANIZATIONS: Organization[] = [
  {
    id: 'org_7vBmC4dKpLqRtNsWoXeA',
    name: 'Acme Corp',
    slug: 'acme-corp',
    logo: null,
    createdAt: '2024-02-10T13:00:00.000Z',
    metadata: '{"industry":"technology","size":"50-200"}',
    memberCount: 2,
    members: [
      { id: 'mem_1aBcD2eF3gH4iJ5kL6mN', organizationId: 'org_7vBmC4dKpLqRtNsWoXeA', userId: 'usr_5nRmW9tGxKqPsUvCeL7zBi', role: 'owner', createdAt: '2024-02-10T13:00:00.000Z' },
      { id: 'mem_7oP8qR9sT0uV1wX2yZ3A', organizationId: 'org_7vBmC4dKpLqRtNsWoXeA', userId: 'usr_8jHkD4aNcOeQyMfTgX2rVo', role: 'member', createdAt: '2024-04-15T09:30:00.000Z' },
    ],
  },
  {
    id: 'org_3pNkQ8rFjTwUyZaXcVdGs',
    name: 'Startup XYZ',
    slug: 'startup-xyz',
    logo: null,
    createdAt: '2024-07-22T08:15:00.000Z',
    metadata: null,
    memberCount: 1,
    members: [
      { id: 'mem_B4cD5eF6gH7iJ8kL9mN0', organizationId: 'org_3pNkQ8rFjTwUyZaXcVdGs', userId: 'usr_1cEwZ6sPiLnXbQdRkA9mFu', role: 'owner', createdAt: '2024-07-22T08:15:00.000Z' },
    ],
  },
];

export const MOCK_USER_APPLICATIONS: UserApplication[] = [
  { userId: 'usr_5nRmW9tGxKqPsUvCeL7zBi', applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', isActive: true, subscriptionPlanId: 'plan-0001-0000-0000-000000000002', subscriptionPlanName: 'Pro', createdAt: '2024-03-25T10:00:00.000Z', name: 'Sofia Marchetti', email: 'sofia.marchetti@example.com', roleId: 'a1b2c3d4-0001-0000-0000-000000000002', lastLoginAt: '2024-11-14T08:21:00.000Z', lastIp: '91.198.174.192', lastUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/132.0' },
  { userId: 'usr_1cEwZ6sPiLnXbQdRkA9mFu', applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', isActive: true, subscriptionPlanId: 'plan-0001-0000-0000-000000000001', subscriptionPlanName: 'Free', createdAt: '2024-09-05T08:00:00.000Z', name: 'Margot Lefèvre', email: 'margot.lefevre@example.com', roleId: 'a1b2c3d4-0001-0000-0000-000000000001', lastLoginAt: null, lastIp: null, lastUserAgent: null },
];

export const MOCK_CONSUMPTION: ConsumptionAggregate[] = [
  { userId: 'usr_5nRmW9tGxKqPsUvCeL7zBi', applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', key: 'api.calls', total: '84230', updatedAt: '2024-11-15T08:55:00.000Z' },
  { userId: 'usr_5nRmW9tGxKqPsUvCeL7zBi', applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', key: 'tokens', total: '1250000', updatedAt: '2024-11-14T22:00:00.000Z' },
  { userId: 'usr_1cEwZ6sPiLnXbQdRkA9mFu', applicationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', key: 'api.calls', total: '312', updatedAt: '2024-11-10T12:00:00.000Z' },
];

export const MOCK_SERVICES_CONFIG: ServicesConfig = {
  stripe: true,
  compat: {
    profile: 'okta',
    tokenAuthMethod: 'basic',
    signingAlg: 'RS256',
    defaultAudience: true,
    audienceParam: false,
    claimMappings: [
      { claim: 'groups', source: 'roles', scope: 'groups' },
      { claim: 'scp', source: 'scope' },
      { claim: 'preferred_username', source: 'email', scope: 'profile' },
      { claim: 'cid', source: 'clientId' },
    ],
    aliases: ['okta'],
  },
  providers: {
    google: { enabled: true, clientId: 'AIzaSyD-sample-google-id' },
    github: { enabled: true, clientId: 'gh-sample-client-id' },
    linkedin: { enabled: false },
    microsoft: { enabled: false },
    apple: { enabled: false },
  },
};

export const MOCK_CURRENT_USER: User = MOCK_USERS[0];

// ── Demo population ───────────────────────────────────────────────────────────
// Enough fictional data for the dashboard, lists and charts to look like a live
// platform (used for the documentation screenshots). Deterministic on purpose:
// no randomness, dates relative to "now" so the recent-activity charts are never empty.

const DAY_MS = 86_400_000;
const daysAgo = (n: number, hour = 9): string => {
  const d = new Date(Date.now() - n * DAY_MS);
  d.setUTCHours(hour, (n * 7) % 60, 0, 0);
  return d.toISOString();
};

function appRecord(over: Partial<Application> & Pick<Application, 'id' | 'name' | 'slug'>): Application {
  return {
    description: null,
    isActive: true,
    skipConsent: false,
    isMfaRequired: false,
    allowRegister: true,
    billingMode: 'none',
    allowedScopes: ['openid', 'profile', 'email'],
    redirectUris: [`https://${over.slug}.example.com/callback`],
    isPublic: true,
    isSystem: false,
    url: `https://${over.slug}.example.com`,
    allowedResources: [],
    icon: null,
    enabledSocialProviders: null,
    enableEndSession: true,
    postLogoutRedirectUris: [],
    backchannelLogoutUri: null,
    backchannelLogoutSessionRequired: false,
    metadata: {},
    createdAt: daysAgo(120),
    updatedAt: daysAgo(12),
    ...over,
  };
}

const DEMO_APPS: Application[] = [
  appRecord({ id: 'a0000001-0000-4000-8000-000000000001', name: 'Chat App', slug: 'chat-app', description: 'AI chat assistant for customers.', allowedResources: ['https://llm.example.com'], enabledSocialProviders: ['google', 'github'], createdAt: daysAgo(96) }),
  appRecord({ id: 'a0000001-0000-4000-8000-000000000002', name: 'Docs Assistant', slug: 'docs-assistant', description: 'Answers questions about the documentation.', allowedResources: ['https://llm.example.com'], createdAt: daysAgo(64) }),
  appRecord({ id: 'a0000001-0000-4000-8000-000000000003', name: 'Billing Portal', slug: 'billing-portal', description: 'Invoices, plans and payment methods.', isPublic: false, isMfaRequired: true, createdAt: daysAgo(150) }),
  appRecord({ id: 'a0000001-0000-4000-8000-000000000004', name: 'LiteLLM gateway', slug: 'litellm', description: 'LLM and MCP gateway (protected resource).', isPublic: false, isSystem: true, allowRegister: false, url: 'https://llm.example.com', redirectUris: [], createdAt: daysAgo(30) }),
  appRecord({ id: 'a0000001-0000-4000-8000-000000000005', name: 'Auth Service API', slug: 'auth-service', description: 'Protected resource for auth-service user APIs.', isPublic: false, isSystem: true, allowRegister: false, url: 'https://auth.example.com', redirectUris: [], createdAt: daysAgo(30) }),
];

const NAMES = [
  ['Emma', 'Laurent'], ['Lucas', 'Bernard'], ['Chloé', 'Moreau'], ['Hugo', 'Petit'], ['Inès', 'Roux'], ['Noah', 'Fournier'],
  ['Jade', 'Girard'], ['Louis', 'Bonnet'], ['Léa', 'Dupont'], ['Arthur', 'Lambert'], ['Manon', 'Fontaine'], ['Jules', 'Rousseau'],
  ['Camille', 'Vincent'], ['Adam', 'Muller'], ['Sarah', 'Lefebvre'], ['Raphaël', 'Mercier'], ['Zoé', 'Blanc'], ['Nathan', 'Guerin'],
  ['Alice', 'Faure'], ['Ethan', 'Andre'], ['Lina', 'Garnier'], ['Tom', 'Chevalier'], ['Clara', 'Francois'], ['Maxime', 'Perrin'],
  ['Eva', 'Morel'], ['Théo', 'Henry'], ['Anna', 'Robin'], ['Paul', 'Masson'], ['Nina', 'Marchand'], ['Enzo', 'Duval'],
  ['Lou', 'Denis'], ['Sacha', 'Meyer'], ['Mila', 'Brunet'], ['Gabin', 'Leclerc'], ['Rose', 'Colin'], ['Axel', 'Caron'],
] as const;
const COMPANIES = ['Acme Corp', 'Startup XYZ', 'Northwind', 'Globex', 'Initech', 'Umbrella Labs', 'Stark Industries'];

// Days ago of the most recent sign-ups: a few per day, never the same count twice in a row.
const SIGNUP_DAYS = [0, 0, 0, 1, 1, 2, 2, 2, 2, 3, 4, 4, 5, 5, 5, 6, 6, 8, 9, 9, 10, 12, 13, 13];

const demoUsers: User[] = NAMES.map(([first, last], i) => {
  const slug = `${first}.${last}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const app = DEMO_APPS[i % 3]!;
  const created = SIGNUP_DAYS[i] ?? 14 + i * 3; // an uneven stream of recent sign-ups
  return {
    id: `usr_demo${String(i).padStart(2, '0')}${slug.replace(/\W/g, '').slice(0, 10)}`,
    name: `${first} ${last}`,
    email: `${slug}@example.com`,
    emailVerified: i % 9 !== 4,
    image: null,
    createdAt: daysAgo(created),
    updatedAt: daysAgo(Math.max(0, created - 2)),
    twoFactorEnabled: i % 4 === 0,
    role: 'user',
    banned: null,
    banReason: null,
    banExpires: null,
    isMfaRequired: null,
    phone: null,
    company: COMPANIES[i % COMPANIES.length]!,
    position: null,
    address: null,
    lastLoginAt: i % 11 === 10 ? null : daysAgo(i % 7, 8 + (i % 10)),
    applications: [{ id: app.id, name: app.name, slug: app.slug, icon: null }],
  };
});

MOCK_APPLICATIONS.splice(2, 1, ...DEMO_APPS); // replaces the placeholder "Internal API"
MOCK_USERS.push(...demoUsers);

MOCK_SESSIONS.push(
  ...demoUsers.slice(0, 9).map((u, i): Session => ({
    id: `sess_demo${i}`,
    expiresAt: daysAgo(-(20 + i)),
    token: `tok_demo${i}`,
    createdAt: daysAgo(i % 5, 7 + i),
    updatedAt: daysAgo(0, 8 + i),
    ipAddress: `86.${200 + i}.${12 + i * 7}.${40 + i * 3}`,
    userAgent: i % 3 === 0
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0'
      : i % 3 === 1
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/132.0'
        : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15',
    userId: u.id,
    impersonatedBy: null,
    activeOrganizationId: null,
    user: { id: u.id, name: u.name, email: u.email, image: null },
    applications: u.applications,
  })),
);

MOCK_ORGANIZATIONS.push(
  ...['Northwind', 'Globex', 'Initech'].map((name, i): Organization => ({
    id: `org_demo${i}`,
    name,
    slug: name.toLowerCase(),
    logo: null,
    createdAt: daysAgo(60 + i * 20),
    metadata: null,
    memberCount: 4,
    members: demoUsers.slice(i * 4, i * 4 + 4).map((u, j) => ({
      id: `mem_demo${i}${j}`,
      organizationId: `org_demo${i}`,
      userId: u.id,
      role: j === 0 ? 'owner' : 'member',
      createdAt: daysAgo(50 + i * 10),
    })),
  })),
);
