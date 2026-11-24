export const MACHINE_SCOPES = [
  "m2m",
  "wallet:debit",
  "wallet:read",
  "billing:read",
  "consumption:read",
  "consumption:write",
  "resources:authorize",
  "resources:usage:write",
  "resources:validate",
  "gateway:entitlements:read",
  "gateway:inventory:sync",
  "ssh:target:read",
  "ssh:resource:read",
  "device:session:validate",
] as const;
export type MachineScope = (typeof MACHINE_SCOPES)[number];

/**
 * Scopes that only reach the calling application's own data: the routes take
 * the application from the token, never from the request. They are safe to
 * grant by default, unlike the wallet scopes, which reach any user's wallet.
 */
export const APPLICATION_MACHINE_SCOPES = [
  "billing:read",
  "consumption:read",
  "consumption:write",
  "resources:validate",
] as const satisfies readonly MachineScope[];

/** What a new confidential application may request through client_credentials. */
export const DEFAULT_MACHINE_SCOPES: readonly MachineScope[] = [
  "m2m",
  ...APPLICATION_MACHINE_SCOPES,
];

/** Scopes whose routes are served by auth-service itself (`m2m` opens none). */
export function isAuthServiceMachineScope(scope: string): boolean {
  return (
    scope !== "m2m" && (MACHINE_SCOPES as readonly string[]).includes(scope)
  );
}
