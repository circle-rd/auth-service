import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  generateSshIdentity,
  parseSshPublicKey,
} from "../../services/ssh/crypto.js";
import { SSH_PROOF_NAMESPACE } from "../../services/ssh/key-proof.js";

const MAGIC = Buffer.from("SSHSIG");

function field(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function mpint(value: Buffer): Buffer {
  const bytes = value[0] !== undefined && value[0] >= 0x80
    ? Buffer.concat([Buffer.from([0]), value])
    : value;
  return field(bytes);
}

function signedData(namespace: string, message: string): Buffer {
  const digest = createHash("sha512").update(message).digest();
  return Buffer.concat([
    MAGIC,
    field(namespace),
    field(""),
    field("sha512"),
    field(digest),
  ]);
}

function armored(
  publicBlob: Buffer,
  namespace: string,
  signature: Buffer,
): string {
  const blob = Buffer.concat([
    MAGIC,
    Buffer.from([0, 0, 0, 1]),
    field(publicBlob),
    field(namespace),
    field(""),
    field("sha512"),
    field(signature),
  ]);
  const lines = blob.toString("base64").match(/.{1,70}/g) ?? [];
  return [
    "-----BEGIN SSH SIGNATURE-----",
    ...lines,
    "-----END SSH SIGNATURE-----",
  ].join("\n");
}

export interface Signer {
  publicKey: string;
  sign: (message: string, namespace?: string) => string;
}

export function ed25519Signer(): Signer {
  const identity = generateSshIdentity();
  const parsed = parseSshPublicKey(identity.publicKey);
  const key = createPrivateKey(identity.privateKeyPem);
  return {
    publicKey: identity.publicKey,
    sign: (message, namespace = SSH_PROOF_NAMESPACE) => {
      const signature = sign(null, signedData(namespace, message), key);
      return armored(
        parsed.blob,
        namespace,
        Buffer.concat([field("ssh-ed25519"), field(signature)]),
      );
    },
  };
}

export function ecdsaSigner(): Signer {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);
  const blob = Buffer.concat([
    field("ecdsa-sha2-nistp256"),
    field("nistp256"),
    field(point),
  ]);
  return {
    publicKey: `ecdsa-sha2-nistp256 ${blob.toString("base64")}`,
    sign: (message, namespace = SSH_PROOF_NAMESPACE) => {
      const raw = sign(
        "sha256",
        signedData(namespace, message),
        { key: pair.privateKey, dsaEncoding: "ieee-p1363" },
      );
      const parts = Buffer.concat([
        mpint(raw.subarray(0, 32)),
        mpint(raw.subarray(32)),
      ]);
      return armored(
        blob,
        namespace,
        Buffer.concat([field("ecdsa-sha2-nistp256"), field(parts)]),
      );
    },
  };
}

export function rsaSigner(): Signer {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const blob = Buffer.concat([
    field("ssh-rsa"),
    mpint(Buffer.from(jwk.e ?? "", "base64url")),
    mpint(Buffer.from(jwk.n ?? "", "base64url")),
  ]);
  return {
    publicKey: `ssh-rsa ${blob.toString("base64")}`,
    sign: (message, namespace = SSH_PROOF_NAMESPACE) => {
      const signature = sign("sha512", signedData(namespace, message), pair.privateKey);
      return armored(
        blob,
        namespace,
        Buffer.concat([field("rsa-sha2-512"), field(signature)]),
      );
    },
  };
}
