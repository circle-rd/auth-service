import type { JWKOptions } from "better-auth/plugins";
import type { SigningAlg } from "./profiles.js";

const ONE_MONTH_S = 60 * 60 * 24 * 30;

/**
 * Key-pair parameters for an algorithm, as the jwt plugin expects them.
 * `EdDSA` is Ed25519, the compact default for resource servers that can
 * verify it; ES256 stays the cross-provider default.
 */
export function signingKeyPairConfig(alg: SigningAlg): JWKOptions {
  if (alg === "RS256") return { alg: "RS256", modulusLength: 2048 };
  if (alg === "EdDSA") return { alg: "EdDSA", crv: "Ed25519" };
  return { alg: "ES256" };
}

/**
 * jwks options shared by the jwt plugin and the startup key check. Keys rotate
 * monthly and the previous one stays published for another month, so access
 * tokens issued just before a rotation still verify.
 */
export function jwksOptions(alg: SigningAlg) {
  return {
    keyPairConfig: signingKeyPairConfig(alg),
    rotationInterval: ONE_MONTH_S,
    gracePeriod: ONE_MONTH_S,
  };
}
