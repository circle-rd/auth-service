import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { ERR } from "../../errors.js";
import type { ParsedSshPublicKey } from "./crypto.js";
import { assertSshSignature } from "./sshsig.js";

export const SSH_PROOF_NAMESPACE = "auth-service";
export const KEY_CHALLENGE_TTL_SECONDS = 600;

const CHALLENGE =
  /^auth-service-ssh-key:(SHA256:[A-Za-z0-9+/]+):(\d{1,12}):([A-Za-z0-9_-]{43})$/;

// Stateless: the tag binds the challenge to one account and one key.
function tag(userId: string, fingerprint: string, expiry: number): string {
  return createHmac("sha256", config.betterAuth.secret)
    .update(`ssh-key-proof\0${userId}\0${fingerprint}\0${expiry}`)
    .digest("base64url");
}

export interface KeyChallenge {
  challenge: string;
  namespace: string;
  expiresAt: Date;
}

export function issueKeyChallenge(
  userId: string,
  key: ParsedSshPublicKey,
  now: Date = new Date(),
): KeyChallenge {
  const expiry = Math.floor(now.getTime() / 1000) + KEY_CHALLENGE_TTL_SECONDS;
  return {
    challenge: `auth-service-ssh-key:${key.fingerprint}:${expiry}:${tag(userId, key.fingerprint, expiry)}`,
    namespace: SSH_PROOF_NAMESPACE,
    expiresAt: new Date(expiry * 1000),
  };
}

/** The caller must hold the private key: it signed a challenge issued to this account. */
export function assertKeyPossession(
  userId: string,
  key: ParsedSshPublicKey,
  proof: { challenge: string; signature: string },
  now: Date = new Date(),
): void {
  const match = CHALLENGE.exec(proof.challenge);
  const fingerprint = match?.[1];
  const expiry = Number(match?.[2]);
  const given = match?.[3];
  if (!fingerprint || !given || fingerprint !== key.fingerprint) {
    throw ERR.AUTH_011("SSH key proof of possession failed");
  }
  const expected = Buffer.from(tag(userId, fingerprint, expiry));
  const actual = Buffer.from(given);
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual) ||
    expiry * 1000 <= now.getTime()
  ) {
    throw ERR.AUTH_011("SSH key proof of possession failed");
  }
  assertSshSignature({
    publicKeyBlob: key.blob,
    namespace: SSH_PROOF_NAMESPACE,
    message: proof.challenge,
    armored: proof.signature,
  });
}
