import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// ── Environment ───────────────────────────────────────────────────────────────

const scriptEnvSchema = z.object({
  BETTER_AUTH_URL: z.string().url(),
  AUTH_SERVICE_URL: z.string().url().optional(),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(12),
  LITELLM_PUBLIC_URL: z.string().url(),
  LITELLM_URL: z.string().url().optional(),
  LITELLM_MASTER_KEY: z.string().min(1).optional(),
});

export type ScriptEnv = z.infer<typeof scriptEnvSchema> & {
  authUrl: string;
  litellmUrl: string;
};

export function loadScriptEnv(): ScriptEnv {
  const parsed = scriptEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${fields}`);
  }
  const env = parsed.data;
  return {
    ...env,
    authUrl: env.AUTH_SERVICE_URL ?? env.BETTER_AUTH_URL,
    litellmUrl: env.LITELLM_URL ?? env.LITELLM_PUBLIC_URL,
  };
}

/**
 * Return `content` with `KEY=value` set. An existing non-empty assignment is
 * kept untouched (never overwrite a generated secret); an empty one is filled.
 */
export function upsertEnvValue(
  content: string,
  key: string,
  value: string,
): string {
  const assignment = new RegExp(`^${key}=(.*)$`, "m");
  const match = assignment.exec(content);
  if (match) {
    if (match[1]!.trim() !== "") return content;
    return content.replace(assignment, `${key}=${value}`);
  }
  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}${key}=${value}\n`;
}

export function generateSecret(prefix = ""): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

// ── JWT / PKCE helpers ────────────────────────────────────────────────────────

export function decodeJwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Access token is not a JWT");
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── auth-service admin client ─────────────────────────────────────────────────

const applicationSchema = z.object({
  id: z.string(),
  slug: z.string(),
  url: z.string().nullable(),
  allowedResources: z.array(z.string()),
});
export type AdminApplication = z.infer<typeof applicationSchema>;

const createdApplicationSchema = z.object({
  application: applicationSchema,
  clientSecret: z.string().optional(),
});

const jsonRedirectSchema = z.object({
  redirect: z.literal(true),
  url: z.string(),
});

/** BetterAuth answers with either a 302 or a JSON `{ redirect, url }` body. */
async function redirectTarget(res: Response): Promise<string> {
  const location = res.headers.get("location");
  if (location) return location;
  const body = jsonRedirectSchema.safeParse(
    await res.json().catch(() => undefined),
  );
  return body.success ? body.data.url : "";
}

const tokenResponseSchema = z.object({ access_token: z.string() });

export class AuthAdminClient {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly baseUrl: string) {}

  private async send(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<Response> {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("Origin", new URL(this.baseUrl).origin);
    if (json !== undefined) headers.set("Content-Type", "application/json");
    if (this.cookies.size > 0) {
      headers.set(
        "Cookie",
        [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      );
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...rest,
      headers,
      body: json === undefined ? rest.body : JSON.stringify(json),
      redirect: "manual",
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const eq = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, eq), pair!.slice(eq + 1));
    }
    return res;
  }

  private async expectOk(res: Response, what: string): Promise<Response> {
    if (!res.ok) {
      throw new Error(`${what} failed: HTTP ${res.status} ${await res.text()}`);
    }
    return res;
  }

  async signIn(email: string, password: string): Promise<void> {
    const res = await this.send("/api/auth/sign-in/email", {
      method: "POST",
      json: { email, password },
    });
    await this.expectOk(res, "Admin sign-in");
    if (this.cookies.size === 0) {
      throw new Error(
        "Admin sign-in returned no session cookie (MFA or email verification required?)",
      );
    }
  }

  async listApplications(): Promise<AdminApplication[]> {
    const res = await this.expectOk(
      await this.send("/api/admin/applications"),
      "List applications",
    );
    return z
      .object({ applications: z.array(applicationSchema) })
      .parse(await res.json()).applications;
  }

  async createApplication(
    body: Record<string, unknown>,
  ): Promise<{ application: AdminApplication; clientSecret?: string }> {
    const res = await this.expectOk(
      await this.send("/api/admin/applications", {
        method: "POST",
        json: body,
      }),
      "Create application",
    );
    return createdApplicationSchema.parse(await res.json());
  }

  async updateApplication(
    id: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await this.expectOk(
      await this.send(`/api/admin/applications/${id}`, {
        method: "PATCH",
        json: body,
      }),
      "Update application",
    );
  }

  async deleteApplication(id: string): Promise<void> {
    await this.expectOk(
      await this.send(`/api/admin/applications/${id}`, { method: "DELETE" }),
      "Delete application",
    );
  }

  /** Authorization-code + PKCE flow driven with the admin session. */
  async requestUserToken(opts: {
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    resource: string;
  }): Promise<string> {
    const { verifier, challenge } = createPkcePair();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      scope: "openid profile email",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "smoke",
      resource: opts.resource,
    });
    const authorize = await this.send(`/api/auth/oauth2/authorize?${query}`);
    const location = await redirectTarget(authorize);
    if (!location.startsWith(opts.redirectUri)) {
      throw new Error(
        `Authorization did not redirect to the client (HTTP ${authorize.status}): ${location}`,
      );
    }
    const redirected = new URL(location);
    const code = redirected.searchParams.get("code");
    if (!code) {
      throw new Error(
        `Authorization failed: ${redirected.searchParams.get("error_description") ?? location}`,
      );
    }
    return this.exchange(
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: opts.redirectUri,
        code_verifier: verifier,
        client_id: opts.clientId,
        resource: opts.resource,
      },
      opts.clientId,
      opts.clientSecret,
    );
  }

  async requestClientCredentialsToken(opts: {
    clientId: string;
    clientSecret: string;
    resource: string;
  }): Promise<string> {
    return this.exchange(
      {
        grant_type: "client_credentials",
        scope: "m2m",
        resource: opts.resource,
      },
      opts.clientId,
      opts.clientSecret,
    );
  }

  private async exchange(
    form: Record<string, string>,
    clientId: string,
    clientSecret?: string,
  ): Promise<string> {
    const headers = new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: new URL(this.baseUrl).origin,
    });
    if (clientSecret) {
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      );
    }
    const res = await fetch(`${this.baseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers,
      body: new URLSearchParams(form),
    });
    await this.expectOk(res, "Token request");
    return tokenResponseSchema.parse(await res.json()).access_token;
  }
}
