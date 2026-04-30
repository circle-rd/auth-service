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
  roleId: string | null
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
