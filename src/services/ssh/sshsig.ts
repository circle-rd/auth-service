import {
  constants,
  createHash,
  createPublicKey,
  verify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { ApiError, ERR } from "../../errors.js";

const MAGIC = Buffer.from("SSHSIG");
const ARMOR =
  /^-----BEGIN SSH SIGNATURE-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END SSH SIGNATURE-----$/;
const MESSAGE_HASHES = new Set(["sha256", "sha512"]);
const ECDSA_CURVES: Record<
  string,
  { crv: string; size: number; hash: string }
> = {
  "ecdsa-sha2-nistp256": { crv: "P-256", size: 32, hash: "sha256" },
  "ecdsa-sha2-nistp384": { crv: "P-384", size: 48, hash: "sha384" },
  "ecdsa-sha2-nistp521": { crv: "P-521", size: 66, hash: "sha512" },
};

class WireReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  bytes(length: number): Buffer {
    if (this.offset + length > this.buffer.length) {
      throw new RangeError("Truncated SSH structure");
    }
    const out = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  uint32(): number {
    return this.bytes(4).readUInt32BE(0);
  }

  string(): Buffer {
    return this.bytes(this.uint32());
  }

  get done(): boolean {
    return this.offset === this.buffer.length;
  }
}

function field(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

// An SSH mpint is a big-endian integer with an optional leading zero byte.
function unsigned(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  return value.subarray(start);
}

function padded(value: Buffer, size: number): Buffer {
  if (value.length > size) throw new RangeError("Oversized ECDSA component");
  return Buffer.concat([Buffer.alloc(size - value.length), value]);
}

function importPublicKey(blob: Buffer): { type: string; key: KeyObject } {
  const reader = new WireReader(blob);
  const type = reader.string().toString();
  let jwk: JsonWebKey;
  if (type === "ssh-ed25519") {
    jwk = {
      kty: "OKP",
      crv: "Ed25519",
      x: reader.string().toString("base64url"),
    };
  } else if (type === "ssh-rsa") {
    const e = unsigned(reader.string());
    const n = unsigned(reader.string());
    jwk = {
      kty: "RSA",
      e: e.toString("base64url"),
      n: n.toString("base64url"),
    };
  } else {
    const curve = ECDSA_CURVES[type];
    if (!curve) throw new RangeError("Unsupported key type");
    reader.string();
    const point = reader.string();
    if (point[0] !== 4 || (point.length - 1) % 2 !== 0) {
      throw new RangeError("Unsupported EC point encoding");
    }
    const half = (point.length - 1) / 2;
    jwk = {
      kty: "EC",
      crv: curve.crv,
      x: point.subarray(1, 1 + half).toString("base64url"),
      y: point.subarray(1 + half).toString("base64url"),
    };
  }
  return { type, key: createPublicKey({ key: jwk, format: "jwk" }) };
}

function verifyBlob(
  type: string,
  key: KeyObject,
  signed: Buffer,
  signature: Buffer,
): boolean {
  const reader = new WireReader(signature);
  const format = reader.string().toString();
  const blob = reader.string();
  if (!reader.done) return false;
  if (type === "ssh-ed25519") {
    return format === type && verify(null, signed, key, blob);
  }
  if (type === "ssh-rsa") {
    // `ssh-rsa` itself names SHA-1, which is not accepted.
    const hash =
      format === "rsa-sha2-512"
        ? "sha512"
        : format === "rsa-sha2-256"
          ? "sha256"
          : null;
    return (
      hash !== null &&
      verify(hash, signed, { key, padding: constants.RSA_PKCS1_PADDING }, blob)
    );
  }
  const curve = ECDSA_CURVES[type];
  if (!curve || format !== type) return false;
  const parts = new WireReader(blob);
  const r = unsigned(parts.string());
  const s = unsigned(parts.string());
  if (!parts.done) return false;
  return verify(
    curve.hash,
    signed,
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.concat([padded(r, curve.size), padded(s, curve.size)]),
  );
}

/**
 * Verify an OpenSSH `SSHSIG` signature (`ssh-keygen -Y sign`) of `message`
 * made by the key whose wire blob is `publicKeyBlob`, in `namespace`.
 */
export function assertSshSignature(input: {
  publicKeyBlob: Buffer;
  namespace: string;
  message: string;
  armored: string;
}): void {
  const armor = ARMOR.exec(input.armored.trim());
  if (!armor?.[1]) throw ERR.RES_001("Invalid SSH signature");
  let valid: boolean;
  try {
    const reader = new WireReader(
      Buffer.from(armor[1].replace(/\s+/g, ""), "base64"),
    );
    if (!reader.bytes(MAGIC.length).equals(MAGIC) || reader.uint32() !== 1) {
      throw ERR.RES_001("Invalid SSH signature");
    }
    const signer = reader.string();
    const namespace = reader.string().toString();
    reader.string();
    const hashName = reader.string().toString();
    const signature = reader.string();
    if (!reader.done) throw ERR.RES_001("Invalid SSH signature");
    if (
      !signer.equals(input.publicKeyBlob) ||
      namespace !== input.namespace ||
      !MESSAGE_HASHES.has(hashName)
    ) {
      throw ERR.AUTH_011("SSH key proof of possession failed");
    }
    const digest = createHash(hashName).update(input.message).digest();
    const signed = Buffer.concat([
      MAGIC,
      field(namespace),
      field(""),
      field(hashName),
      field(digest),
    ]);
    const { type, key } = importPublicKey(signer);
    valid = verifyBlob(type, key, signed, signature);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ERR.RES_001("Invalid SSH signature");
  }
  if (!valid) throw ERR.AUTH_011("SSH key proof of possession failed");
}
