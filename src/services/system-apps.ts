/** Slugs of the infrastructure applications provisioned for the LLM gateway. */
export const LITELLM_GATEWAY_SLUG = "litellm";
export const LITELLM_UI_SLUG = "litellm-ui";
/** Auth Service itself, registered as a protected resource for its own user APIs. */
export const AUTH_SERVICE_SLUG = "auth-service";

/** The single entry that stands for the whole gateway in a user's access list. */
const LITELLM_META_NAME = "LiteLLM";

interface UserApplicationRow {
  slug: string;
  name: string;
  isSystem: boolean;
}

/**
 * The applications of a user as an administrator should see them: system
 * applications are infrastructure, so they are hidden, except the LiteLLM admin
 * interface, which stands for "this user can administer the gateway" and is shown
 * as one `LiteLLM` entry (its role still tells administrator from viewer).
 */
export function presentUserApplications<T extends UserApplicationRow>(
  rows: T[],
): Omit<T, "isSystem">[] {
  return rows
    .filter((row) => !row.isSystem || row.slug === LITELLM_UI_SLUG)
    .map(({ isSystem, ...row }) => ({
      ...row,
      name: isSystem ? LITELLM_META_NAME : row.name,
    }));
}
