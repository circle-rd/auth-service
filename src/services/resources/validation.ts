import { ERR } from "../../errors.js";
import { linkResourceToGatewayObject } from "../gateway-inventory.js";
import { setSshHostKeyFingerprint } from "../ssh/targets.js";
import {
  getResource,
  markResourceInvalidated,
  markResourceValidated,
  markResourceValidationFailed,
  type ResourceView,
} from "./registry.js";
import { assertSchemeValidator } from "./scheme-service.js";

export const VALIDATION_RESULTS = ["validated", "validation_failed"] as const;
export type ValidationResult = (typeof VALIDATION_RESULTS)[number];

export interface CompleteValidationInput {
  resourceId: string;
  clientId: string;
  result: ValidationResult;
  reason?: string | null;
  evidence?: Record<string, unknown> | null;
}

/**
 * Only the machine client bound to the resource scheme may complete a
 * validation. The resource state, not the caller, decides whether the result is
 * accepted.
 */
export async function completeResourceValidation(
  input: CompleteValidationInput,
): Promise<ResourceView> {
  const resource = await getResource(input.resourceId);
  await assertSchemeValidator(resource.scheme, input.clientId);
  if (resource.status === "disabled") {
    throw ERR.RES_001("Resource is disabled");
  }
  if (
    resource.status !== "pending_validation" &&
    resource.status !== "validation_failed" &&
    resource.status !== "validated"
  ) {
    throw ERR.RES_001("Resource cannot be validated in its current state");
  }
  if (input.result === "validated") {
    if (
      resource.scheme === "llm" ||
      resource.scheme === "agent" ||
      resource.scheme === "mcp"
    ) {
      const linked = await linkResourceToGatewayObject(resource);
      if (!linked) {
        throw ERR.RES_011("Resource is not present in the gateway inventory");
      }
    }
    if (resource.scheme === "ssh") {
      const fingerprint = input.evidence?.hostKeyFingerprint;
      if (typeof fingerprint !== "string") {
        throw ERR.RES_001("SSH validation requires the host key fingerprint");
      }
      await setSshHostKeyFingerprint(resource.id, fingerprint);
    }
    return markResourceValidated(resource.id);
  }
  return markResourceValidationFailed(
    resource.id,
    input.reason?.trim() || "Validation failed",
  );
}

export interface InvalidateResourceInput {
  resourceId: string;
  clientId: string;
  reason: string;
}

/** Asynchronous ownership-loss callback from an adapter. */
export async function invalidateResource(
  input: InvalidateResourceInput,
): Promise<ResourceView> {
  const resource = await getResource(input.resourceId);
  await assertSchemeValidator(resource.scheme, input.clientId);
  const reason = input.reason.trim();
  if (reason === "") throw ERR.RES_001("An invalidation reason is required");
  return markResourceInvalidated(resource.id, reason);
}
