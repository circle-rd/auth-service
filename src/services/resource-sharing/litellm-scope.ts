/**
 * Path-only allowlist of the shared-resource sync credential.
 *
 * LiteLLM v1.108.3 matches `allowed_routes` against the request path, not the
 * method, so the HTTP method allowlist below is enforced by the client and
 * checked during provisioning. Nothing outside these two paths may be called.
 */
export const RESOURCE_SYNC_ROUTES = [
  "/v1/access_group",
  "/v1/access_group/*",
] as const;

const LIST_ROUTE = /^\/v1\/access_group$/;
const UPDATE_ROUTE = /^\/v1\/access_group\/[^/]+$/;

export function resourceSyncMethodAllowed(
  method: string,
  path: string,
): boolean {
  switch (method.toUpperCase()) {
    case "GET":
      return LIST_ROUTE.test(path);
    case "PUT":
      return UPDATE_ROUTE.test(path);
    default:
      return false;
  }
}
