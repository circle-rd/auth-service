// Rate-limit exemptions: see the global rate-limit registration in edge-plugins.ts.
export const RATE_LIMIT_EXEMPT_PATHS = [
  "/api/auth/oauth2/token",
  "/api/auth/jwks",
  "/api/auth/.well-known/",
];
export const AUTH_RATE_PATHS = [
  "/api/auth/sign-in/email",
  "/api/auth/sign-in/social",
  "/api/auth/request-password-reset",
  "/api/auth/forget-password",
  "/api/auth/reset-password",
  "/api/auth/sign-up/email",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-backup-code",
  "/api/auth/passkey/generate-register-options",
  "/api/auth/passkey/verify-registration",
  "/api/auth/passkey/generate-authenticate-options",
  "/api/auth/passkey/verify-authentication",
  "/api/user/gateway-keys",
];
export const AUTH_RATE_WINDOW = 60_000;

// A passkey sign-in performs a method lookup, an options request and a
// verification; sharing the 10/min credential bucket would allow only two
// logins per minute behind a shared IP.
export const MFA_RATE_PATHS = [
  "/api/auth/mfa/methods",
  "/api/auth/mfa/passkey/options",
  "/api/auth/mfa/passkey/verify-authentication",
];
export const MFA_RATE_MAX = 30;
export const MFA_RATE_WINDOW = 60_000;

export const EMAIL_SEND_PATHS = [
  // BetterAuth >=1.6 renamed `/forget-password` to `/request-password-reset`;
  // the legacy path is kept for back-compat with older clients that still POST
  // to it (it routes to the same handler via plugin aliases).
  "/api/auth/request-password-reset",
  "/api/auth/forget-password",
  "/api/auth/send-verification-email",
  "/api/auth/sign-in/magic-link",
  "/api/auth/change-email",
  "/api/auth/organization/invite-member",
  "/api/auth/email-otp/send-verification-otp",
  "/api/auth/email-otp/request-password-reset",
];
// Dynamic owner paths cannot be listed as static prefixes without throttling
// unrelated owner APIs, so the endpoints that send mail are matched exactly.
export const EMAIL_SEND_PATH_PATTERNS = [
  /^\/api\/user\/apps\/[^/]+\/invitations$/,
  /^\/api\/user\/apps\/[^/]+\/members$/,
];
export const EMAIL_SEND_MAX = 5;
export const EMAIL_SEND_WINDOW = 60_000;

// Team writes that create a team, redeem an invitation token or issue one. The
// token is the bearer credential of a so these share one small budget.
export const TEAM_RATE_PATTERNS = [
  /^\/api\/user\/organizations$/,
  /^\/api\/user\/organizations\/join$/,
  /^\/api\/user\/organizations\/[^/]+\/invitation-token$/,
];
export const TEAM_RATE_MAX = 60;
export const TEAM_RATE_WINDOW = 60_000;

// Device authorization (RFC 8628, opt-in). `/device/code` is unauthenticated
// and writes a row per call; `/device/token` is polled every few seconds per
// device, so it needs a looser ceiling than credential endpoints.
export const DEVICE_RATE_PATHS = ["/api/auth/device"];
export const DEVICE_RATE_MAX = 60;
export const DEVICE_RATE_WINDOW = 60_000;

/** Cadence of the online-user count that feeds the admin dashboard. */
export const PRESENCE_INTERVAL_MS = 30_000;
