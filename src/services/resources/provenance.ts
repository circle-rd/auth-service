export const RELAY_MANAGER = "reverse-relay";

/**
 * A gateway object proves its declarer only when the relay wrote it for that
 * account. The relay names every deployment `{client_id}/{model}` from the
 * identity it verified on the tunnel, so the object's name and its
 * `client_id` must both start with the declaring username. A LiteLLM admin can
 * write any `model_info`; this check holds because only the relay's key creates
 * `managed_by = reverse-relay` deployments.
 */
export function isRelayDeclaration(
  metadata: Record<string, unknown>,
  objectName: string,
  username: string,
): boolean {
  if (username.length === 0) return false;
  if (metadata.managedBy !== RELAY_MANAGER) return false;
  if (metadata.clientId !== username) return false;
  if (metadata.reverseName !== objectName) return false;
  return objectName.startsWith(`${username}/`);
}
