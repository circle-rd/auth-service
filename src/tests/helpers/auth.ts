/**
 * Integration test auth helpers.
 *
 * Provides factory functions that return the shape `auth.api.getSession`
 * resolves to, used with `vi.spyOn` in integration tests so BetterAuth does
 * not need to be fully booted.
 */

export interface MockSession {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    emailVerified: boolean;
    banned: boolean | null;
    createdAt: Date;
    updatedAt: Date;
  };
  session: {
    id: string;
    token: string;
    userId: string;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  };
}

const now = new Date();

export function makeSuperadminSession(id = "superadmin-1"): MockSession {
  return {
    user: {
      id,
      email: `${id}@example.com`,
      name: "Superadmin",
      role: "superadmin",
      emailVerified: true,
      banned: null,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: `session-${id}`,
      token: `token-${id}`,
      userId: id,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
  };
}

export function makeAdminSession(id = "admin-1"): MockSession {
  return {
    user: {
      id,
      email: `${id}@example.com`,
      name: "Admin",
      role: "admin",
      emailVerified: true,
      banned: null,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: `session-${id}`,
      token: `token-${id}`,
      userId: id,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
  };
}

export function makeUserSession(id = "user-1"): MockSession {
  return {
    user: {
      id,
      email: `${id}@example.com`,
      name: "User",
      role: "user",
      emailVerified: true,
      banned: null,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: `session-${id}`,
      token: `token-${id}`,
      userId: id,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
  };
}
