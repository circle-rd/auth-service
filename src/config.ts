import { z } from "zod";
import "dotenv/config";

// Zod's `z.coerce.boolean()` uses `Boolean(value)`, so the string "false"
// becomes `true`. Env flags must be parsed strictly instead: `z.stringbool()`
// accepts true/false, 1/0, yes/no and on/off (case-insensitive), and rejects
// anything else so a typo fails the startup check rather than silently
// enabling a security-sensitive flow. An empty string is treated as unset.
const envBoolean = (defaultValue: boolean) =>
  z
    .union([z.stringbool(), z.literal("")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? defaultValue : v));

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3001),
    HOST: z.string().default("0.0.0.0"),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),

    BETTER_AUTH_SECRET: z.string().min(16),
    BETTER_AUTH_URL: z.string().url(),

    // Display name used as TOTP issuer in authenticator apps and as BetterAuth
    // appName. Falls back to a sensible default when unset.
    APP_NAME: z.string().min(1).default("CIRCLE Auth"),

    // Optional logo URL displayed in the UI (sidebar, login, consent). When unset,
    // the frontend falls back to the bundled default logo.
    APP_LOGO_URL: z.string().url().optional(),

    DATABASE_URL: z.string().url(),

    ADMIN_EMAIL: z.string().email().optional(),
    // Bootstrap superadmin password. Minimum 12 characters (startup fails fast
    // with a clear message otherwise); the bootstrap also refuses known
    // default placeholders such as the one in .env.example.
    ADMIN_PASSWORD: z.string().min(12).optional(),

    CORS_ORIGINS: z.string().default("http://localhost:5173"),
    SESSION_DOMAIN: z.string().optional(),

    // Number of trusted reverse-proxy hops in front of the service. Passed to
    // Fastify's `trustProxy` so `req.ip` is derived from the right entry in the
    // `X-Forwarded-For` chain instead of the (spoofable) client-supplied value.
    // Defaults to 0 (secure): set it explicitly to 1 (or the exact hop count)
    // when running behind a reverse proxy, otherwise req.ip is the proxy address
    // and per-IP rate limiting collapses into one bucket. Leaving it at 0 while
    // a proxy is in front means a forged X-Forwarded-For is ignored.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().default("auth-service <no-reply@localhost>"),
    // Optional default Reply-To header injected on every outbound email. When
    // unset, no Reply-To is added (recipients reply to SMTP_FROM).
    MAIL_REPLY_TO: z.string().optional(),

    // Email verification gating. When true (the default in production),
    // BetterAuth refuses to issue a session for an unverified account; the
    // user is sent a verification email and bounced to /verify-email.
    // Explicitly leaving the variable empty keeps the production default.
    REQUIRE_EMAIL_VERIFICATION: z
      .union([z.stringbool(), z.literal("")])
      .optional()
      .transform((v) => (v === "" || v === undefined ? undefined : v)),

    // Opt-in passwordless flows. Both default to false because they expand the
    // attack surface (anyone who knows a user's email can trigger a send).
    // Enable only after rate-limits and SMTP are in place.
    MAGIC_LINK_ENABLED: envBoolean(false),
    EMAIL_OTP_ENABLED: envBoolean(false),

    // ── Phase 5b optional features ─────────────────────────────────────────
    // Reject passwords found in the Have I Been Pwned corpus (k-anonymity: only
    // a 5-char SHA-1 prefix leaves the process). Opt-in because it makes an
    // outbound call on every password write.
    HAVEIBEENPWNED_ENABLED: envBoolean(false),
    // Cookie-based "last used sign-in method" hint. No database column needed.
    LAST_LOGIN_METHOD_ENABLED: envBoolean(false),
    // OAuth 2.0 Device Authorization Grant (RFC 8628). Adds the `deviceCode`
    // table and /device approval page; opt-in because it widens the schema.
    DEVICE_AUTHORIZATION_ENABLED: envBoolean(false),

    // CAPTCHA on credential endpoints. Deliberately opt-in via CAPTCHA_ENABLED
    // (not merely by setting keys): enabling it rejects sign-in, sign-up and
    // password reset until every client submits `x-captcha-response`, so it must
    // be a conscious action after the widget ships. Requires provider + secret +
    // site key.
    CAPTCHA_ENABLED: envBoolean(false),
    CAPTCHA_PROVIDER: z
      .enum([
        "cloudflare-turnstile",
        "google-recaptcha",
        "hcaptcha",
        "captchafox",
      ])
      .optional(),
    CAPTCHA_SECRET_KEY: z.string().optional(),
    // Public site key, surfaced to clients via /api/app-config.
    CAPTCHA_SITE_KEY: z.string().optional(),
    // Comma-separated override of the protected endpoint list (defaults to
    // sign-up, sign-in and password reset).
    CAPTCHA_ENDPOINTS: z.string().optional(),

    // Optional Redis URL for shared rate-limit state across instances. When
    // unset, the in-memory buckets are used (single-instance only).
    REDIS_URL: z.string().url().optional(),

    // Templates directory — optional, allows overriding login/register/verify-email pages
    // per-application (mount a volume at this path in Docker)
    TEMPLATES_DIR: z.string().optional(),

    // Stripe (optional — billing integration)
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    // OAuth social providers (optional — each requires CLIENT_ID + CLIENT_SECRET)
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    LINKEDIN_CLIENT_ID: z.string().optional(),
    LINKEDIN_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    APPLE_CLIENT_ID: z.string().optional(),
    APPLE_CLIENT_SECRET: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // A half-configured CAPTCHA would otherwise silently stay disabled (all
    // three fields are required by `captcha.enabled`), or — if it did activate
    // without a site key — lock every credential flow out. Fail fast instead.
    if (
      data.CAPTCHA_ENABLED &&
      (!data.CAPTCHA_PROVIDER ||
        !data.CAPTCHA_SECRET_KEY ||
        !data.CAPTCHA_SITE_KEY)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["CAPTCHA_ENABLED"],
        message:
          "requires CAPTCHA_PROVIDER, CAPTCHA_SECRET_KEY and CAPTCHA_SITE_KEY",
      });
    }
  });

// Docker Compose passes unset variables as empty strings. Treat those as
// absent so `.default()` / `.optional()` apply instead of failing validation
// (e.g. an empty ADMIN_EMAIL must not be rejected as an invalid email).
const rawEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== ""),
);
const parsed = envSchema.safeParse(rawEnv);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

// Email-flow gating: in production, any active email-sending feature requires
// a real SMTP host. The historical `requireEmailVerification` default was
// `false`; we keep that fallback in dev/test but flip it to `true` in prod.
const isProduction = parsed.data.NODE_ENV === "production";
const requireEmailVerification =
  parsed.data.REQUIRE_EMAIL_VERIFICATION ?? isProduction;
const anyEmailFlowEnabled =
  requireEmailVerification ||
  parsed.data.MAGIC_LINK_ENABLED ||
  parsed.data.EMAIL_OTP_ENABLED;

if (isProduction && anyEmailFlowEnabled && !parsed.data.SMTP_HOST) {
  console.error(
    "Invalid environment configuration:\n" +
      "  SMTP_HOST is required in production when REQUIRE_EMAIL_VERIFICATION, " +
      "MAGIC_LINK_ENABLED, or EMAIL_OTP_ENABLED is on.\n" +
      "  Either set SMTP_HOST, or disable the email-dependent flows.",
  );
  process.exit(1);
}

export const config = {
  port: parsed.data.PORT,
  host: parsed.data.HOST,
  nodeEnv: parsed.data.NODE_ENV,
  isDev: parsed.data.NODE_ENV === "development",
  betterAuth: {
    secret: parsed.data.BETTER_AUTH_SECRET,
    url: parsed.data.BETTER_AUTH_URL,
  },
  appName: parsed.data.APP_NAME,
  appLogoUrl: parsed.data.APP_LOGO_URL,
  db: {
    url: parsed.data.DATABASE_URL,
  },
  bootstrap: {
    adminEmail: parsed.data.ADMIN_EMAIL,
    adminPassword: parsed.data.ADMIN_PASSWORD,
  },
  cors: {
    origins: parsed.data.CORS_ORIGINS.split(",").map((o) => o.trim()),
  },
  session: {
    domain: parsed.data.SESSION_DOMAIN,
  },
  trustProxyHops: parsed.data.TRUST_PROXY_HOPS,
  smtp: {
    host: parsed.data.SMTP_HOST,
    port: parsed.data.SMTP_PORT,
    user: parsed.data.SMTP_USER,
    pass: parsed.data.SMTP_PASS,
    from: parsed.data.SMTP_FROM,
    replyTo: parsed.data.MAIL_REPLY_TO,
  },
  email: {
    requireVerification: requireEmailVerification,
    magicLinkEnabled: parsed.data.MAGIC_LINK_ENABLED,
    otpEnabled: parsed.data.EMAIL_OTP_ENABLED,
  },
  features: {
    haveIBeenPwned: parsed.data.HAVEIBEENPWNED_ENABLED,
    lastLoginMethod: parsed.data.LAST_LOGIN_METHOD_ENABLED,
    deviceAuthorization: parsed.data.DEVICE_AUTHORIZATION_ENABLED,
  },
  captcha: {
    enabled: !!(
      parsed.data.CAPTCHA_ENABLED &&
      parsed.data.CAPTCHA_PROVIDER &&
      parsed.data.CAPTCHA_SECRET_KEY &&
      parsed.data.CAPTCHA_SITE_KEY
    ),
    provider: parsed.data.CAPTCHA_PROVIDER,
    secretKey: parsed.data.CAPTCHA_SECRET_KEY,
    siteKey: parsed.data.CAPTCHA_SITE_KEY,
    endpoints: parsed.data.CAPTCHA_ENDPOINTS
      ? parsed.data.CAPTCHA_ENDPOINTS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  },
  redis: {
    url: parsed.data.REDIS_URL,
  },
  stripe: {
    secretKey: parsed.data.STRIPE_SECRET_KEY,
    webhookSecret: parsed.data.STRIPE_WEBHOOK_SECRET,
  },
  templatesDir: parsed.data.TEMPLATES_DIR ?? null,
  providers: {
    google: {
      enabled: !!(
        parsed.data.GOOGLE_CLIENT_ID && parsed.data.GOOGLE_CLIENT_SECRET
      ),
      clientId: parsed.data.GOOGLE_CLIENT_ID,
      clientSecret: parsed.data.GOOGLE_CLIENT_SECRET,
    },
    github: {
      enabled: !!(
        parsed.data.GITHUB_CLIENT_ID && parsed.data.GITHUB_CLIENT_SECRET
      ),
      clientId: parsed.data.GITHUB_CLIENT_ID,
      clientSecret: parsed.data.GITHUB_CLIENT_SECRET,
    },
    linkedin: {
      enabled: !!(
        parsed.data.LINKEDIN_CLIENT_ID && parsed.data.LINKEDIN_CLIENT_SECRET
      ),
      clientId: parsed.data.LINKEDIN_CLIENT_ID,
      clientSecret: parsed.data.LINKEDIN_CLIENT_SECRET,
    },
    microsoft: {
      enabled: !!(
        parsed.data.MICROSOFT_CLIENT_ID && parsed.data.MICROSOFT_CLIENT_SECRET
      ),
      clientId: parsed.data.MICROSOFT_CLIENT_ID,
      clientSecret: parsed.data.MICROSOFT_CLIENT_SECRET,
    },
    apple: {
      enabled: !!(
        parsed.data.APPLE_CLIENT_ID && parsed.data.APPLE_CLIENT_SECRET
      ),
      clientId: parsed.data.APPLE_CLIENT_ID,
      clientSecret: parsed.data.APPLE_CLIENT_SECRET,
    },
  },
} as const;
