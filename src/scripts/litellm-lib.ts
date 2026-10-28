import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { LedgerEntry } from "./litellm-reconcile-lib.js";

// ── Environment ───────────────────────────────────────────────────────────────

const scriptEnvSchema = z.object({
  BETTER_AUTH_URL: z.string().url(),
  AUTH_SERVICE_URL: z.string().url().optional(),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(12),
  LITELLM_PUBLIC_URL: z.string().url(),
  LITELLM_URL: z.string().url().optional(),
  LITELLM_MASTER_KEY: z.string().min(1).optional(),
  LITELLM_WALLET_CLIENT_SECRET: z.string().min(1).optional(),
  LITELLM_DB_ADMIN_URL: z.string().url().optional(),
  LITELLM_SSO_ENABLED: z.enum(["true", "false"]).default("true"),
});

/** Machine application the gateway uses to call the wallet API. */
export const WALLET_CLIENT_SLUG = "litellm-wallet";
// Scopes granted to the gateway's own machine client (`litellm-wallet`): the
// wallet debit/read the LLM hook uses, and `wallet:read`, which the gateway also
// uses to resolve a user's plan/team for its custom auth. No dedicated scope:
// reusing one already granted keeps an in-place upgrade from having to re-grant
// scopes (which needs an administrator without MFA) before the gateway can serve.
export const WALLET_SCOPES = ["wallet:debit", "wallet:read"];

export type ScriptEnv = z.infer<typeof scriptEnvSchema> & {
  authUrl: string;
  litellmUrl: string;
};

export function loadScriptEnv(): ScriptEnv {
  // Compose passes unset variables as empty strings: treat them as absent.
  const present = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== ""),
  );
  const parsed = scriptEnvSchema.safeParse(present);
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

/** Value of `KEY=value` in `content`, or undefined when absent or empty. */
export function readEnvValue(content: string, key: string): string | undefined {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(content);
  return match?.[1]?.trim() || undefined;
}

export type SecretAction = "kept" | "generated" | "supplied" | "replaced";

/**
 * Settle one secret of a state file. A value supplied by the operator (through
 * the environment) wins and is stored; otherwise the stored one is kept; only
 * when there is neither is a new one generated. Nothing stored is ever
 * regenerated: a lost salt key would make the stored provider credentials
 * unreadable.
 */
export function resolveSecret(
  content: string,
  key: string,
  supplied: string | undefined,
  generate: () => string,
): { content: string; action: SecretAction } {
  const stored = readEnvValue(content, key);
  const wanted = supplied?.trim() || undefined;
  if (wanted && wanted === stored) return { content, action: "kept" };
  if (wanted) {
    return {
      content: replaceEnvValue(content, key, wanted),
      action: stored ? "replaced" : "supplied",
    };
  }
  if (stored) return { content, action: "kept" };
  return {
    content: replaceEnvValue(content, key, generate()),
    action: "generated",
  };
}

/** Return `content` with `KEY=value`, replacing any existing assignment. */
export function replaceEnvValue(
  content: string,
  key: string,
  value: string,
): string {
  const assignment = new RegExp(`^${key}=.*$`, "m");
  if (assignment.test(content)) {
    return content.replace(assignment, () => `${key}=${value}`);
  }
  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}${key}=${value}\n`;
}

/** Return `content` without any `KEY=` assignment. */
export function removeEnvValue(content: string, key: string): string {
  return content.replace(new RegExp(`^${key}=.*\\n?`, "m"), "");
}

/**
 * `value` as one shell word. The state file is sourced by `sh` before the
 * gateway starts, so a value with spaces, quotes or braces must be quoted.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface SsoGatewayUrls {
  /** Public URL of the gateway (the browser comes back to `/sso/callback`). */
  gatewayPublicUrl: string;
  /** Public URL of auth-service, where the browser is sent to sign in. */
  authPublicUrl: string;
  /** Address of auth-service the gateway itself reaches (token, userinfo). */
  authInternalUrl: string;
}

/**
 * Every LiteLLM setting of the admin-interface sign-in through auth-service
 * (generic OIDC), except the client id and secret. They are written next to the
 * secrets by `litellm-setup`, so the gateway configuration always matches the
 * auth-service version that provisioned it and a deployment cannot go on with an
 * older copy of it in its compose file.
 */
export function ssoGatewayEnv(urls: SsoGatewayUrls): Record<string, string> {
  const trim = (u: string) => u.replace(/\/+$/, "");
  return {
    PROXY_BASE_URL: trim(urls.gatewayPublicUrl),
    GENERIC_AUTHORIZATION_ENDPOINT: `${trim(urls.authPublicUrl)}/api/auth/oauth2/authorize`,
    GENERIC_TOKEN_ENDPOINT: `${trim(urls.authInternalUrl)}/api/auth/oauth2/token`,
    GENERIC_USERINFO_ENDPOINT: `${trim(urls.authInternalUrl)}/api/auth/oauth2/userinfo`,
    GENERIC_SCOPE: "openid profile email roles",
    // auth-service requires PKCE (OAuth 2.1).
    GENERIC_CLIENT_USE_PKCE: "true",
    // Straight to auth-service from the login page. Password sign-in is disabled
    // while SSO is on (litellm/config.yaml): the master key is for the API only.
    AUTO_REDIRECT_UI_LOGIN_TO_SSO: "true",
    GENERIC_USER_ID_ATTRIBUTE: "sub",
    GENERIC_USER_EMAIL_ATTRIBUTE: "email",
    GENERIC_USER_DISPLAY_NAME_ATTRIBUTE: "name",
    // The application role `admin` makes a LiteLLM administrator, `user` (or no
    // role) a read-only viewer.
    GENERIC_ROLE_MAPPINGS_GROUP_CLAIM: "roles",
    GENERIC_ROLE_MAPPINGS_ROLES:
      '{"proxy_admin": ["admin"], "proxy_admin_viewer": ["user"]}',
    GENERIC_ROLE_MAPPINGS_DEFAULT_ROLE: "proxy_admin_viewer",
  };
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
  isSystem: z.boolean().default(false),
  redirectUris: z.array(z.string()).default([]),
  allowedScopes: z.array(z.string()).default([]),
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

const twoFactorChallengeSchema = z.object({
  twoFactorRedirect: z.literal(true),
});

export class TwoFactorRequiredError extends Error {
  constructor(email: string) {
    super(
      `Admin sign-in requires a second factor: ${email} has MFA enabled, but the setup scripts can only sign in with a password. Use an administrator account without MFA (see docs: LiteLLM gateway).`,
    );
    this.name = "TwoFactorRequiredError";
  }
}

/**
 * Whether a previous run of `litellm-setup` left everything the gateway reads
 * from the state file: the keys, the wallet client secret and, with the admin
 * interface sign-in on, the SSO client secret.
 */
export function isSetupComplete(state: string, ssoEnabled: boolean): boolean {
  const required = [
    "LITELLM_MASTER_KEY",
    "LITELLM_SALT_KEY",
    "LITELLM_WALLET_CLIENT_SECRET",
    ...(ssoEnabled ? ["GENERIC_CLIENT_SECRET"] : []),
  ];
  return required.every((key) => readEnvValue(state, key) !== undefined);
}

const walletAccountSchema = z.object({
  balance: z.string().regex(/^-?[0-9]+$/),
  canSpend: z.boolean(),
});

const usageLedgerPageSchema = z.object({
  items: z.array(
    z.object({
      requestId: z.string().nullable(),
      userId: z.string(),
      amount: z.string(),
      costUsd: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

const tokenResponseSchema = z.object({ access_token: z.string() });

const ADMIN_SCRIPT_USER_AGENT = "auth-service-admin-script";

export class AuthAdminClient {
  private readonly cookies = new Map<string, string>();

  /**
   * `origin` is the public origin sent with requests: auth-service only trusts
   * its own public URL, which differs from `baseUrl` when the script reaches it
   * over an internal network address.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly origin: string = new URL(baseUrl).origin,
  ) {}

  protected async send(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<Response> {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("Origin", this.origin);
    // Names the session in the admin "Active Sessions" list.
    headers.set("User-Agent", ADMIN_SCRIPT_USER_AGENT);
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

  protected async expectOk(res: Response, what: string): Promise<Response> {
    if (!res.ok) {
      throw new Error(`${what} failed: HTTP ${res.status} ${await res.text()}`);
    }
    return res;
  }

  /** Signs in and returns the id of the signed-in user. */
  async signIn(email: string, password: string): Promise<string> {
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
    const body: unknown = await res.json();
    // The twoFactor plugin answers 200 with a pending-challenge cookie and no user.
    if (twoFactorChallengeSchema.safeParse(body).success) {
      throw new TwoFactorRequiredError(email);
    }
    return z.object({ user: z.object({ id: z.string() }) }).parse(body).user.id;
  }

  /**
   * Ends the session opened by `signIn`. Every run of a script signs in, so
   * without this each `docker compose up` would leave a live admin session behind.
   * A failure here must not hide the outcome of the script, so it only warns.
   */
  async signOut(): Promise<void> {
    if (this.cookies.size === 0) return;
    try {
      await this.expectOk(
        await this.send("/api/auth/sign-out", { method: "POST", json: {} }),
        "Admin sign-out",
      );
    } catch (err) {
      process.stderr.write(
        `! ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    this.cookies.clear();
  }

  async listRoles(appId: string): Promise<{ id: string; name: string }[]> {
    const res = await this.expectOk(
      await this.send(`/api/admin/applications/${appId}/roles`),
      "List roles",
    );
    return z
      .object({
        roles: z.array(z.object({ id: z.string(), name: z.string() })),
      })
      .parse(await res.json()).roles;
  }

  /** Users with access to the application, with their role id when they have one. */
  async listApplicationUsers(
    appId: string,
  ): Promise<{ userId: string; roleId: string | null }[]> {
    const res = await this.expectOk(
      await this.send(`/api/admin/applications/${appId}/users`),
      "List application users",
    );
    return z
      .object({
        users: z.array(
          z.object({ userId: z.string(), roleId: z.string().nullable() }),
        ),
      })
      .parse(await res.json()).users;
  }

  async grantAccess(
    appId: string,
    body: { userId: string; roleId?: string },
  ): Promise<void> {
    await this.expectOk(
      await this.send(`/api/admin/applications/${appId}/users`, {
        method: "POST",
        json: body,
      }),
      "Grant application access",
    );
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

  async getMachineScopes(id: string): Promise<string[]> {
    const res = await this.expectOk(
      await this.send(`/api/admin/applications/${id}/machine-scopes`),
      "Read machine scopes",
    );
    return z.object({ scopes: z.array(z.string()) }).parse(await res.json())
      .scopes;
  }

  async setMachineScopes(id: string, scopes: string[]): Promise<void> {
    await this.expectOk(
      await this.send(`/api/admin/applications/${id}/machine-scopes`, {
        method: "PUT",
        json: { scopes },
      }),
      "Set machine scopes",
    );
  }

  /** Invalidates the previous secret and every token issued with it. */
  async rotateSecret(id: string): Promise<string> {
    const res = await this.expectOk(
      await this.send(`/api/admin/applications/${id}/rotate-secret`, {
        method: "POST",
      }),
      "Rotate client secret",
    );
    return z.object({ clientSecret: z.string() }).parse(await res.json())
      .clientSecret;
  }

  /** True when the client credentials are accepted for the requested scope. */
  async canObtainToken(opts: {
    clientId: string;
    clientSecret: string;
    scope: string;
  }): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: this.origin,
        Authorization: `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: opts.scope,
      }),
    });
    if (res.ok) return true;
    // Only a refusal of the credentials means they are wrong: a rate limit or an
    // outage must not make the caller rotate a secret that still works.
    if (res.status === 400 || res.status === 401) return false;
    throw new Error(
      `Checking the "${opts.clientId}" credentials failed: HTTP ${res.status} ${await res.text()}`,
    );
  }

  async getWallet(
    userId: string,
  ): Promise<{ balance: bigint; canSpend: boolean }> {
    const res = await this.expectOk(
      await this.send(`/api/admin/wallets/users/${userId}`),
      "Read wallet",
    );
    const account = walletAccountSchema.parse(await res.json());
    return { balance: BigInt(account.balance), canSpend: account.canSpend };
  }

  /** Gateway usage debits created in `[from, to)`, oldest first. */
  async usageLedger(from: Date, to: Date): Promise<LedgerEntry[]> {
    const entries: LedgerEntry[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        limit: "1000",
      });
      if (cursor) params.set("cursor", cursor);
      const res = await this.expectOk(
        await this.send(`/api/admin/wallets/usage-ledger?${params}`),
        "Read usage ledger",
      );
      const page = usageLedgerPageSchema.parse(await res.json());
      entries.push(
        ...page.items.map((i) => ({ ...i, createdAt: new Date(i.createdAt) })),
      );
      cursor = page.nextCursor;
    } while (cursor);
    return entries;
  }

  /** Record credit as an administrator would for a manual invoice. */
  async topUp(
    userId: string,
    micro: bigint,
    reference: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.expectOk(
      await this.send(`/api/admin/wallets/users/${userId}/topups`, {
        method: "POST",
        json: { amount: micro.toString(), idempotencyKey, reference },
      }),
      "Top up wallet",
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
    resource?: string;
    scope?: string;
  }): Promise<string> {
    return this.exchange(
      {
        grant_type: "client_credentials",
        scope: opts.scope ?? "m2m",
        ...(opts.resource ? { resource: opts.resource } : {}),
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
      Origin: this.origin,
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
