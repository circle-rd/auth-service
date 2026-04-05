import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().url(),

  DATABASE_URL: z.string().url(),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),

  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  SESSION_DOMAIN: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("auth-service <no-reply@localhost>"),

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

export const config = {
  port: parsed.data.PORT,
  host: parsed.data.HOST,
  nodeEnv: parsed.data.NODE_ENV,
  isDev: parsed.data.NODE_ENV === "development",
  betterAuth: {
    secret: parsed.data.BETTER_AUTH_SECRET,
    url: parsed.data.BETTER_AUTH_URL,
  },
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
  smtp: {
    host: parsed.data.SMTP_HOST,
    port: parsed.data.SMTP_PORT,
    user: parsed.data.SMTP_USER,
    pass: parsed.data.SMTP_PASS,
    from: parsed.data.SMTP_FROM,
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
