import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  sendVerificationEmail: vi.fn(),
  inserts: [] as { table: string; values: Record<string, unknown> }[],
  failTransaction: undefined as unknown,
}));

vi.mock("better-auth/node", () => ({ fromNodeHeaders: vi.fn(() => ({})) }));
vi.mock("better-auth", () => ({ generateId: () => "generated-id" }));
vi.mock("better-auth/crypto", () => ({
  hashPassword: vi.fn((p: string) => Promise.resolve(`scrypt:${p}`)),
}));
vi.mock("../auth.js", () => ({
  auth: {
    api: {
      createUser: mocks.createUser,
      sendVerificationEmail: mocks.sendVerificationEmail,
    },
  },
}));
vi.mock("../db/auth-schema.js", () => ({
  user: { __table: "user" },
  account: { __table: "account" },
}));
vi.mock("../db/index.js", () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      if (mocks.failTransaction) throw mocks.failTransaction;
      await fn({
        insert: (table: { __table: string }) => ({
          values: (values: Record<string, unknown>) => {
            mocks.inserts.push({ table: table.__table, values });
            return Promise.resolve();
          },
        }),
      });
    },
  },
}));

import { importUsers, importUsersSchema } from "./user-import.js";

const bcryptHash = `$2b$10$${"a".repeat(53)}`;

function run(
  users: unknown[],
  over: {
    callerRole?: string;
    mailConfigured?: boolean;
    sendVerification?: boolean;
  } = {},
) {
  return importUsers({
    input: importUsersSchema.parse({
      users,
      ...(over.sendVerification === undefined
        ? {}
        : { sendVerification: over.sendVerification }),
    }),
    callerRole: over.callerRole ?? "superadmin",
    callerId: "admin-1",
    headers: {},
    mailConfigured: over.mailConfigured ?? true,
  });
}

beforeEach(() => {
  mocks.createUser.mockReset().mockResolvedValue({});
  mocks.sendVerificationEmail.mockReset().mockResolvedValue({});
  mocks.inserts.length = 0;
  mocks.failTransaction = undefined;
});

describe("importUsersSchema", () => {
  it("refuses a password together with a hash and unprintable ids", () => {
    const base = { name: "A", email: "a@example.com" };
    for (const row of [
      {
        ...base,
        password: "longenough1",
        passwordHash: { algorithm: "bcrypt", hash: bcryptHash },
      },
      { ...base, id: "has space" },
      { ...base, id: "" },
    ]) {
      expect(importUsersSchema.safeParse({ users: [row] }).success).toBe(false);
    }
  });
});

describe("importUsers", () => {
  it("sends plain rows through BetterAuth and returns a temporary password", async () => {
    const out = await run([{ name: "Ann", email: "Ann@Example.com" }]);
    expect(mocks.createUser).toHaveBeenCalledTimes(1);
    expect(mocks.createUser.mock.calls[0]?.[0].body).toMatchObject({
      email: "ann@example.com",
    });
    expect(out.created).toBe(1);
    expect(typeof out.results[0]?.password).toBe("string");
    expect(mocks.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it("does not return the password it was given, nor mail when told not to", async () => {
    const out = await run(
      [{ name: "Ann", email: "ann@example.com", password: "longenough1" }],
      { sendVerification: false },
    );
    expect(out.results[0]?.password).toBeUndefined();
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("writes trusted rows directly with the given id, verification and hash", async () => {
    const out = await run([
      {
        id: "auth0|1",
        name: "Ann",
        email: "ann@example.com",
        emailVerified: true,
        passwordHash: { algorithm: "bcrypt", hash: bcryptHash },
      },
    ]);
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.inserts.map((i) => i.table)).toEqual(["user", "account"]);
    expect(mocks.inserts[0]?.values).toMatchObject({
      id: "auth0|1",
      emailVerified: true,
      role: "user",
    });
    expect(mocks.inserts[1]?.values).toMatchObject({
      providerId: "credential",
      userId: "auth0|1",
      password: bcryptHash,
    });
    expect(out.results[0]?.password).toBeUndefined();
    // Verified: no mail.
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("hashes a given password and generates one when there is none", async () => {
    const out = await run([
      { id: "x1", name: "A", email: "a@example.com", password: "given-pass-1" },
      { id: "x2", name: "B", email: "b@example.com" },
    ]);
    expect(mocks.inserts[1]?.values.password).toBe("scrypt:given-pass-1");
    expect(out.results[0]?.password).toBeUndefined();
    expect(out.results[1]?.password).toBeTruthy();
    expect(mocks.inserts[3]?.values.password).toBe(
      `scrypt:${out.results[1]?.password}`,
    );
  });

  it("limits ids, verification and hashes to superadmins, and admin roles too", async () => {
    const out = await run(
      [
        { id: "x", name: "A", email: "a@example.com" },
        { name: "B", email: "b@example.com", emailVerified: true },
        { name: "C", email: "c@example.com", role: "admin" },
        { name: "D", email: "d@example.com" },
      ],
      { callerRole: "admin" },
    );
    expect(out.results.map((r) => r.status)).toEqual([
      "error",
      "error",
      "error",
      "created",
    ]);
    expect(out.created).toBe(1);
    expect(out.failed).toBe(3);
  });

  it("reports a duplicate (unique violation, also when wrapped) per row", async () => {
    mocks.failTransaction = { cause: { code: "23505" } };
    const out = await run([{ id: "dup", name: "A", email: "a@example.com" }]);
    expect(out.results[0]).toMatchObject({ status: "error" });
    expect(out.results[0]?.message).toMatch(/already exists/);
  });

  it("reports any other failure with its message", async () => {
    mocks.createUser.mockRejectedValue(
      new Error("User already exists. Use another email."),
    );
    mocks.failTransaction = "boom";
    const out = await run([
      { name: "A", email: "a@example.com" },
      { id: "t", name: "B", email: "b@example.com" },
    ]);
    expect(out.results[0]?.message).toMatch(/already exists/);
    expect(out.results[1]?.message).toBe("Failed to create user");
  });

  it("survives a verification mail that fails to send", async () => {
    mocks.sendVerificationEmail.mockRejectedValue(new Error("smtp down"));
    const out = await run([{ name: "A", email: "a@example.com" }]);
    expect(out.created).toBe(1);
  });
});
