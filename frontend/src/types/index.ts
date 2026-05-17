export interface User {
  id: string
  name: string
  email: string
  emailVerified: boolean
  image: string | null
  createdAt: string
  updatedAt: string
  twoFactorEnabled: boolean | null
  role: 'superadmin' | 'admin' | 'user' | null
  banned: boolean | null
  banReason: string | null
  banExpires: string | null
  isMfaRequired: boolean | null
  phone: string | null
  company: string | null
  position: string | null
  address: string | null
  /** ISO timestamp of the most recent OAuth token issuance. Null when the user has never logged in. */
  lastLoginAt?: string | null
  /** Applications the user currently has active access to. Populated by /admin/users. */
  applications?: UserAppSummary[]
}

export interface UserAppSummary {
  id: string
  name: string
  slug: string
  icon: string | null
}

export interface Session {
  id: string
  expiresAt: string
  token: string
  createdAt: string
  updatedAt: string
  ipAddress: string | null
  userAgent: string | null
  userId: string
  impersonatedBy: string | null
  activeOrganizationId: string | null
  /** Enriched user identity (populated by /admin/sessions). */
  user?: { id: string; name: string | null; email: string | null; image: string | null }
  /** Applications this user has logged into during the session lifespan. */
  applications?: UserAppSummary[]
}

export interface MfaSetupResult {
  totpURI: string
  backupCodes: string[]
}

export interface MfaBackupCodesResult {
  backupCodes: string[]
}

export type MfaMethod = 'totp' | 'otp'

export interface MfaChallengeState {
  pending: boolean
  methods: MfaMethod[]
}

export interface SignInResult {
  twoFactorRedirect?: boolean
  twoFactorMethods?: MfaMethod[]
}

export interface Application {
  id: string
  name: string
  slug: string
  description: string | null
  isActive: boolean
  skipConsent: boolean
  isMfaRequired: boolean
  allowRegister: boolean
  allowedScopes: string[]
  redirectUris: string[]
  isPublic: boolean
  url: string | null
  icon: string | null
  enabledSocialProviders: string[] | null
  metadata: Record<string, string>
  /** OIDC RP-Initiated Logout 1.0 — mirrors `oauth_client.enable_end_session`. */
  enableEndSession: boolean
  /** Whitelist for `post_logout_redirect_uri` on the end-session endpoint. */
  postLogoutRedirectUris: string[]
  createdAt: string
  updatedAt: string
}

export interface ApplicationCreateResponse {
  application: Application
  clientId: string
  clientSecret?: string
}

export interface AppRole {
  id: string
  applicationId: string
  name: string
  description: string | null
  isDefault: boolean
  createdAt: string
  permissionIds: string[]
}

export interface AppPermission {
  id: string
  applicationId: string
  resource: string
  action: 'read' | 'write'
  createdAt: string
}

export interface PlanFeatureFixed {
  usage: false
  value: string | number | boolean
}

export interface PlanFeatureMetered {
  usage: true
  limit: number // -1 = unlimited
  unit: string
  pricePerUnit: number // in smallest currency unit (cents)
}

export type PlanFeature = PlanFeatureFixed | PlanFeatureMetered

export interface SubscriptionPlan {
  id: string
  applicationId: string
  name: string
  description: string | null
  stripeProductId: string | null
  features: Record<string, unknown>
  isDefault: boolean
  createdAt: string
  updatedAt: string
  prices: SubscriptionPlanPrice[]
}

export interface SubscriptionPlanPrice {
  id: string
  planId: string
  name: string
  amount: string
  currency: string
  interval: 'month' | 'year' | 'one_time'
  stripePriceId: string | null
  createdAt: string
}

export interface UserApplication {
  userId: string
  applicationId: string
  isActive: boolean
  subscriptionPlanId: string | null
  createdAt: string
  name: string | null
  email: string | null
  image?: string | null
  roleId: string | null
  /** Most recent login of this user to this application. */
  lastLoginAt?: string | null
  /** IP captured at the most recent login (this app). */
  lastIp?: string | null
  /** User-agent captured at the most recent login (this app). */
  lastUserAgent?: string | null
}

export interface LoginHistoryEntry {
  id: string
  loggedAt: string
  ipAddress: string | null
  userAgent: string | null
  sessionId: string | null
}

export interface LoginHistoryResponse {
  entries: LoginHistoryEntry[]
  total: number
  page: number
  limit: number
}

export interface UserApplicationDetail {
  id: string
  name: string
  slug: string
  icon: string | null
  isActive: boolean
  subscriptionPlanId: string | null
  roles: { id: string; name: string }[]
}

export interface UserSubscription {
  id: string
  userId: string
  applicationId: string
  planId: string
  expiresAt: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface ConsumptionAggregate {
  userId: string
  applicationId: string
  key: string
  total: string
  updatedAt: string
}

export interface Organization {
  id: string
  name: string
  slug: string
  logo: string | null
  createdAt: string
  metadata: string | null
  memberCount?: number
  members?: OrganizationMember[]
}

export interface OrganizationMember {
  id: string
  organizationId: string
  userId: string
  role: 'owner' | 'admin' | 'member'
  createdAt: string
  user?: User
}

export interface Invitation {
  id: string
  organizationId: string
  email: string
  role: 'owner' | 'admin' | 'member' | null
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled'
  expiresAt: string
  inviterId: string
  createdAt: string
}

export interface OAuthProviderConfig {
  enabled: boolean
  clientId?: string
  clientSecret?: string
}

export interface ServicesConfig {
  stripe: boolean
  providers: {
    google: OAuthProviderConfig
    github: OAuthProviderConfig
    linkedin: OAuthProviderConfig
    microsoft: OAuthProviderConfig
    apple: OAuthProviderConfig
  }
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
}
