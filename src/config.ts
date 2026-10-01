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

const envSchema = z.object({
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
  ADMIN_PASSWORD: z.string().min(8).optional(),

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
});

const parsed = envSchema.safeParse(process.env);

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
