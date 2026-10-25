import { z } from "zod";
import type { LegacyHash } from "../services/legacy-password.js";
import type { SourceUser } from "./migrate-lib.js";

export const SOURCES = ["okta", "auth0", "keycloak"] as const;
export type Source = (typeof SOURCES)[number];

// ── Okta (read through its API) ───────────────────────────────────────────────

const oktaUserSchema = z.object({
  id: z.string().min(1),
  profile: z.object({
    email: z.string().nullable().optional(),
    login: z.string().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
  }),
});
const oktaGroupSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  profile: z.object({ name: z.string() }),
});

/** Follow Okta's `Link: <…>; rel="next"` pagination. */
async function* oktaPages<T>(
  url: string,
  token: string,
  schema: z.ZodType<T>,
  fetchFn: typeof fetch,
): AsyncGenerator<T> {
  let next: string | null = url;
  while (next) {
    const res: Response = await fetchFn(next, {
      headers: { Authorization: `SSWS ${token}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Okta answered ${res.status} for ${next}`);
    for (const item of z.array(schema).parse(await res.json())) yield item;
    next =
      /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ??
      null;
  }
}

/** Active Okta users, with the Okta groups they belong to. */
export async function fetchOktaUsers(
  orgUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<SourceUser[]> {
  const base = orgUrl.replace(/\/+$/, "");
  const filter = encodeURIComponent('status eq "ACTIVE"');
  const users = new Map<string, SourceUser>();
  for await (const u of oktaPages(
    `${base}/api/v1/users?limit=200&filter=${filter}`,
    token,
    oktaUserSchema,
    fetchFn,
  )) {
    const email = u.profile.email ?? u.profile.login ?? "";
    const name = [u.profile.firstName, u.profile.lastName]
      .filter(Boolean)
      .join(" ");
    users.set(u.id, {
      id: u.id,
      email,
      name: name || email,
      // Okta has no verified flag: the caller decides with --trust-email.
      emailVerified: true,
      groups: [],
    });
  }

  for await (const g of oktaPages(
    `${base}/api/v1/groups?limit=200`,
    token,
    oktaGroupSchema,
    fetchFn,
  )) {
    // Built-in groups ("Everyone") and app groups are not roles.
    if (g.type !== "OKTA_GROUP") continue;
    for await (const member of oktaPages(
      `${base}/api/v1/groups/${g.id}/users?limit=200`,
      token,
      z.object({ id: z.string() }),
      fetchFn,
    )) {
      users.get(member.id)?.groups.push(g.profile.name);
    }
  }
  return [...users.values()];
}

// ── Auth0 (user export file) ──────────────────────────────────────────────────

const auth0UserSchema = z.object({
  user_id: z.string().min(1),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  nickname: z.string().optional(),
  passwordHash: z.string().optional(),
  app_metadata: z
    .object({ roles: z.array(z.string()).optional() })
    .passthrough()
    .optional(),
});

/** Auth0 exports are either a JSON array or one JSON object per line. */
function jsonRecords(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("["))
    return z.array(z.unknown()).parse(JSON.parse(trimmed));
  return trimmed
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
}

export function parseAuth0Export(text: string): SourceUser[] {
  return jsonRecords(text).flatMap((raw) => {
    const u = auth0UserSchema.parse(raw);
    if (!u.email) return [];
    const hash: LegacyHash | undefined = u.passwordHash
      ? { algorithm: "bcrypt", hash: u.passwordHash }
      : undefined;
    return [
      {
        id: u.user_id,
        email: u.email,
        name: u.name ?? u.nickname ?? u.email,
        emailVerified: u.email_verified ?? false,
        groups: u.app_metadata?.roles ?? [],
        passwordHash: hash,
      },
    ];
  });
}

// ── Keycloak (realm export file) ──────────────────────────────────────────────

const jsonString = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .string()
    .transform((s) => JSON.parse(s) as unknown)
    .pipe(schema);

const keycloakCredentialSchema = z.object({
  type: z.string(),
  secretData: jsonString(
    z.object({ value: z.string(), salt: z.string() }),
  ).optional(),
  credentialData: jsonString(
    z.object({ hashIterations: z.number(), algorithm: z.string() }),
  ).optional(),
});
const keycloakUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().optional(),
  email: z.string().optional(),
  emailVerified: z.boolean().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  groups: z.array(z.string()).optional(),
  realmRoles: z.array(z.string()).optional(),
  serviceAccountClientId: z.string().optional(),
  credentials: z.array(keycloakCredentialSchema).optional(),
});
const keycloakRealmSchema = z.object({
  users: z.array(keycloakUserSchema).default([]),
});

const KEYCLOAK_DIGESTS: Record<string, "sha256" | "sha512"> = {
  "pbkdf2-sha256": "sha256",
  "pbkdf2-sha512": "sha512",
};
// Roles Keycloak gives every user: not application roles.
const KEYCLOAK_BUILTIN_ROLE =
  /^(default-roles-.+|offline_access|uma_authorization)$/;

export function parseKeycloakRealm(text: string): SourceUser[] {
  const realm = keycloakRealmSchema.parse(JSON.parse(text));
  return realm.users.flatMap((u) => {
    if (!u.email || u.serviceAccountClientId) return [];
    const credential = u.credentials?.find((c) => c.type === "password");
    const digest = credential?.credentialData
      ? KEYCLOAK_DIGESTS[credential.credentialData.algorithm]
      : undefined;
    const hash: LegacyHash | undefined =
      credential?.secretData && credential.credentialData && digest
        ? {
            algorithm: "pbkdf2",
            digest,
            iterations: credential.credentialData.hashIterations,
            salt: credential.secretData.salt,
            hash: credential.secretData.value,
          }
        : undefined;
    const groups = (u.groups ?? []).map(
      (path) => path.split("/").pop() ?? path,
    );
    const roles = (u.realmRoles ?? []).filter(
      (r) => !KEYCLOAK_BUILTIN_ROLE.test(r),
    );
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
    return [
      {
        id: u.id,
        email: u.email,
        name: name || u.username || u.email,
        emailVerified: u.emailVerified ?? false,
        groups: groups.length > 0 ? groups : roles,
        passwordHash: hash,
        unsupportedHash:
          credential?.credentialData && !hash
            ? credential.credentialData.algorithm
            : undefined,
      },
    ];
  });
}
