import { describe, expect, it } from "vitest";
import {
  ecdsaSigner,
  ed25519Signer,
  rsaSigner,
} from "../../tests/helpers/ssh-proof.js";
import { parseSshPublicKey } from "./crypto.js";
import {
  assertKeyPossession,
  issueKeyChallenge,
  KEY_CHALLENGE_TTL_SECONDS,
} from "./key-proof.js";

const NOW = new Date("2026-11-16T10:00:00Z");

describe("SSH key proof of possession", () => {
  for (const [name, make] of [
    ["ed25519", ed25519Signer],
    ["ecdsa", ecdsaSigner],
    ["rsa", rsaSigner],
  ] as const) {
    it(`accepts a challenge signed by the ${name} key`, () => {
      const signer = make();
      const key = parseSshPublicKey(signer.publicKey);
      const { challenge } = issueKeyChallenge("user-1", key, NOW);
      expect(() =>
        assertKeyPossession(
          "user-1",
          key,
          { challenge, signature: signer.sign(challenge) },
          NOW,
        ),
      ).not.toThrow();
    });
  }

  it("refuses a signature made by another key over the same challenge", () => {
    const victim = parseSshPublicKey(ed25519Signer().publicKey);
    const attacker = ed25519Signer();
    const { challenge } = issueKeyChallenge("user-1", victim, NOW);
    expect(() =>
      assertKeyPossession(
        "user-1",
        victim,
        { challenge, signature: attacker.sign(challenge) },
        NOW,
      ),
    ).toThrowError(expect.objectContaining({ code: "AUTH_011" }));
  });

  it("refuses a signature in another namespace or over another message", () => {
    const signer = ed25519Signer();
    const key = parseSshPublicKey(signer.publicKey);
    const { challenge } = issueKeyChallenge("user-1", key, NOW);
    for (const signature of [
      signer.sign(challenge, "git"),
      signer.sign(`${challenge}x`),
    ]) {
      expect(() =>
        assertKeyPossession("user-1", key, { challenge, signature }, NOW),
      ).toThrowError(expect.objectContaining({ code: "AUTH_011" }));
    }
  });

  it("refuses a challenge issued to another account, expired, or for another key", () => {
    const signer = ed25519Signer();
    const key = parseSshPublicKey(signer.publicKey);
    const { challenge } = issueKeyChallenge("user-1", key, NOW);
    const signature = signer.sign(challenge);
    expect(() =>
      assertKeyPossession("user-2", key, { challenge, signature }, NOW),
    ).toThrowError(expect.objectContaining({ code: "AUTH_011" }));

    const later = new Date(
      NOW.getTime() + (KEY_CHALLENGE_TTL_SECONDS + 1) * 1000,
    );
    expect(() =>
      assertKeyPossession("user-1", key, { challenge, signature }, later),
    ).toThrowError(expect.objectContaining({ code: "AUTH_011" }));

    const other = parseSshPublicKey(ed25519Signer().publicKey);
    expect(() =>
      assertKeyPossession("user-1", other, { challenge, signature }, NOW),
    ).toThrowError(expect.objectContaining({ code: "AUTH_011" }));
  });

  it("rejects a malformed signature", () => {
    const key = parseSshPublicKey(ed25519Signer().publicKey);
    const { challenge } = issueKeyChallenge("user-1", key, NOW);
    for (const signature of [
      "nonsense",
      "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----",
    ]) {
      expect(() =>
        assertKeyPossession("user-1", key, { challenge, signature }, NOW),
      ).toThrowError(expect.objectContaining({ code: "RES_001" }));
    }
  });
});
