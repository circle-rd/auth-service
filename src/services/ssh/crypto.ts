import {
  createCipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { config } from "../../config.js";
import { ERR } from "../../errors.js";

const ED25519 = "ssh-ed25519";
const ALLOWED_KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
]);

function u32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function sshBlob(type: string, key: Buffer): Buffer {
  const typeBuffer = Buffer.from(type);
  return Buffer.concat([
    u32(typeBuffer.length),
    typeBuffer,
    u32(key.length),
    key,
  ]);
}

export function sshFingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256")
    .update(blob)
    .digest("base64")
    .replace(/=+$/, "")}`;
}

export interface ParsedSshPublicKey {
  type: string;
  blob: Buffer;
  publicKey: string;
  fingerprint: string;
}

export function parseSshPublicKey(value: string): ParsedSshPublicKey {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 2) throw ERR.RES_001("Invalid SSH public key");
  const [type, encoded] = parts;
  if (!type || !encoded || !ALLOWED_KEY_TYPES.has(type)) {
    throw ERR.RES_001("Unsupported SSH public key type");
  }
  let blob: Buffer;
  try {
    blob = Buffer.from(encoded, "base64");
  } catch {
    throw ERR.RES_001("Invalid SSH public key");
  }
  if (blob.length < 32 || blob.length > 4096) {
    throw ERR.RES_001("Invalid SSH public key");
  }
  return {
    type,
    blob,
    publicKey: `${type} ${blob.toString("base64")}`,
    fingerprint: sshFingerprint(blob),
  };
}

export interface GeneratedSshIdentity {
  publicKey: string;
  fingerprint: string;
  privateKeyPem: string;
}

/** Ed25519 identity in the OpenSSH wire format, without a third-party library. */
export function generateSshIdentity(): GeneratedSshIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) throw ERR.SRV_001("Unexpected Ed25519 public key");
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) throw ERR.SRV_001("Unexpected Ed25519 key length");
  const blob = sshBlob(ED25519, raw);
  const exported = privateKey.export({ type: "pkcs8", format: "pem" });
  if (typeof exported !== "string") {
    throw ERR.SRV_001("Unexpected Ed25519 private key encoding");
  }
  return {
    publicKey: `${ED25519} ${blob.toString("base64")}`,
    fingerprint: sshFingerprint(blob),
    privateKeyPem: exported,
  };
}

function envelopeKey(): Buffer {
  const value = config.sshGateway.envelopeKey;
  if (!value) {
    throw ERR.SRV_001(
      "SSH_GATEWAY_ENVELOPE_KEY is not configured; SSH resources cannot be created",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw ERR.SRV_001("SSH_GATEWAY_ENVELOPE_KEY must be a base64 32-byte key");
  }
  return key;
}

/** AES-256-GCM ciphertext consumed by the gateway; auth-service never decrypts. */
export function encryptSshPrivateKey(privateKeyPem: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", envelopeKey(), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(privateKeyPem, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([nonce, ciphertext, tag]).toString("base64")}`;
}

export function authorizedKeysLine(
  publicKey: string,
  resourceId: string,
): string {
  return `restrict,pty ${publicKey} auth-service:${resourceId}`;
}
