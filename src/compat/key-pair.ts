import type { JWKOptions } from "better-auth/plugins";
import type { SigningAlg } from "./profiles.js";

const ONE_MONTH_S = 60 * 60 * 24 * 30;

/**
 * Key-pair parameters for an algorithm, as the jwt plugin expects them. `EdDSA`
 * is not offered: RFC 9864 deprecates that name, and the plugin does not
 * support its fully specified replacement `Ed25519` yet.
 */
export function signingKeyPairConfig(alg: SigningAlg): JWKOptions {
  return alg === "RS256"
    ? { alg: "RS256", modulusLength: 2048 }
    : { alg: "ES256" };
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
