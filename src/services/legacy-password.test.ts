import { pbkdf2Sync, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { hashPassword } from "better-auth/crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const updates = vi.hoisted(() => ({
  set: vi.fn(),
  where: vi.fn(),
  failNext: false,
}));

vi.mock("../db/index.js", () => ({
  db: {
    update: () => ({
      set: (values: unknown) => {
        updates.set(values);
        return {
          where: (condition: unknown) => {
            updates.where(condition);
            return updates.failNext
              ? Promise.reject(new Error("db down"))
              : Promise.resolve();
          },
        };
      },
    }),
  },
}));

import {
  encodeLegacyHash,
  legacyHashSchema,
  verifyStoredPassword,
} from "./legacy-password.js";

beforeEach(() => {
  updates.set.mockClear();
  updates.where.mockClear();
  updates.failNext = false;
});

function pbkdf2Hash(password: string, digest: "sha256" | "sha512") {
  const salt = randomBytes(16);
  const derived = pbkdf2Sync(password, salt, 1000, 32, digest);
  return encodeLegacyHash({
    algorithm: "pbkdf2",
    digest,
    iterations: 1000,
    salt: salt.toString("base64"),
    hash: derived.toString("base64"),
  });
}

describe("verifyStoredPassword", () => {
  it("verifies a native hash and leaves it alone", async () => {
    const hash = await hashPassword("native-pass-1");
    expect(
      await verifyStoredPassword({ hash, password: "native-pass-1" }),
    ).toBe(true);
    expect(await verifyStoredPassword({ hash, password: "other" })).toBe(false);
    expect(updates.set).not.toHaveBeenCalled();
  });

  it("verifies a bcrypt hash and upgrades it on success only", async () => {
    const hash = bcrypt.hashSync("legacy-pass-1", 4);
    expect(await verifyStoredPassword({ hash, password: "nope" })).toBe(false);
    expect(updates.set).not.toHaveBeenCalled();

    expect(
      await verifyStoredPassword({ hash, password: "legacy-pass-1" }),
    ).toBe(true);
    expect(updates.set).toHaveBeenCalledTimes(1);
    const [{ password }] = updates.set.mock.calls[0] as [{ password: string }];
    expect(password).not.toBe(hash);
    expect(
      await verifyStoredPassword({ hash: password, password: "legacy-pass-1" }),
    ).toBe(true);
  });

  it.each(["sha256", "sha512"] as const)(
    "verifies a pbkdf2-%s hash",
    async (digest) => {
      const hash = pbkdf2Hash("kc-pass-1", digest);
      expect(await verifyStoredPassword({ hash, password: "kc-pass-1" })).toBe(
        true,
      );
      expect(await verifyStoredPassword({ hash, password: "kc-pass-2" })).toBe(
        false,
      );
    },
  );

  it("still accepts the password when the upgrade cannot be stored", async () => {
    updates.failNext = true;
    const hash = bcrypt.hashSync("legacy-pass-1", 4);
    expect(
      await verifyStoredPassword({ hash, password: "legacy-pass-1" }),
    ).toBe(true);
  });

  it("rejects a pbkdf2 string that does not parse", async () => {
    expect(
      await verifyStoredPassword({
        hash: "pbkdf2$md5$1$c2E=$aGE=",
        password: "x",
      }),
    ).toBe(false);
    expect(
      await verifyStoredPassword({
        hash: "pbkdf2$sha256$99999999$c2E=$aGE=",
        password: "x",
      }),
    ).toBe(false);
  });
});

describe("legacyHashSchema", () => {
  it("accepts well-formed hashes and refuses the rest", () => {
    expect(
      legacyHashSchema.safeParse({
        algorithm: "bcrypt",
        hash: bcrypt.hashSync("x", 4),
      }).success,
    ).toBe(true);
    expect(
      legacyHashSchema.safeParse({ algorithm: "scrypt", hash: "x" }).success,
    ).toBe(false);
  });
});
