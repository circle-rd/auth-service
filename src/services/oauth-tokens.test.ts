import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromFn, spec, verifyImpl, thenableOf } = vi.hoisted(() => {
  const spec: Record<string, unknown[]> = {
    jwks: [],
    resources: [],
    opaque: [],
  };
  const verifyImpl = vi.fn();
  const thenableOf = (rows: unknown[]): Record<string, unknown> => ({
    then: (onFulfilled: (value: unknown[]) => unknown) =>
      Promise.resolve(rows).then(onFulfilled),
    where: () => thenableOf(rows),
    limit: () => Promise.resolve(rows),
  });
  const fromFn = vi.fn();
  return { fromFn, spec, verifyImpl, thenableOf };
});

vi.mock("../db/index.js", () => ({
  db: { select: () => ({ from: fromFn }) },
}));

vi.mock("better-auth/oauth2", () => ({
  verifyJwsAccessToken: verifyImpl,
}));

const { invalidateAudiencesCache, verifyBearerAccessToken } =
  await import("./oauth-tokens.js");
const { jwks, oauthAccessToken, oauthResource } =
  await import("../db/auth-schema.js");

const jwkRow = {
  id: "kid-1",
  alg: "RS256",
  crv: null as string | null,
  publicKey: JSON.stringify({ kty: "RSA", n: "x", e: "AQAB" }),
  expiresAt: null,
};

const RESOURCE = { identifier: "https://auth.example.com", disabled: false };

type TableKey = "jwks" | "resources" | "opaque";

const calls = () => fromFn.mock.calls as unknown[][];

const callsFor = (key: TableKey): number =>
  calls().filter(([table]) => table === tableOf(key)).length;

function tableOf(key: TableKey): unknown {
  if (key === "jwks") return jwks;
  if (key === "resources") return oauthResource;
  return oauthAccessToken;
}

const setupQueries = (): void => {
  spec.jwks = [{ ...jwkRow }];
  spec.resources = [{ ...RESOURCE }];
  spec.opaque = [];
  fromFn.mockImplementation((table: unknown) =>
    thenableOf((spec as Record<string, unknown[]>)[keyOf(table)]),
  );
};

function keyOf(table: unknown): TableKey {
  if (table === jwks) return "jwks";
  if (table === oauthResource) return "resources";
  return "opaque";
}

const payload = (overrides: Record<string, unknown> = {}) => ({
  azp: "app-a",
  sub: "user-1",
  aud: ["https://auth.example.com"],
  scope: "openid wallet:self:read",
  ...overrides,
});

type VerifyOpts = {
  jwksFetch?: () => Promise<unknown>;
  verifyOptions?: { audience?: string[] };
};

// The real BetterAuth verifier fetches the key set on every call (its own
// process-level cache sits behind the mock) and rejects a token whose audience
// is not admitted by `verifyOptions.audience`.
const signedSucceeds = (): void => {
  verifyImpl.mockImplementation(async (_token: unknown, opts?: VerifyOpts) => {
    await opts?.jwksFetch?.();
    const audience = opts?.verifyOptions?.audience ?? [];
    expect(audience).toContain(RESOURCE.identifier);
    return payload();
  });
};

beforeEach(() => {
  verifyImpl.mockReset();
  setupQueries();
  signedSucceeds();
  invalidateAudiencesCache();
  fromFn.mockClear();
});

describe("verifyBearerAccessToken audience caching", () => {
  it("reads the audience list once for a burst of verifications", async () => {
    for (let i = 0; i < 10; i += 1) {
      await expect(verifyBearerAccessToken("tok.a.jwt")).resolves.toMatchObject(
        {
          clientId: "app-a",
          userId: "user-1",
        },
      );
    }
    expect(callsFor("resources")).toBe(1);
    // The JWKS fetch is delegated to BetterAuth's internal cache; the mock
    // bypasses it, so the resource-server key set is read per call here.
    expect(callsFor("jwks")).toBe(10);
    expect(callsFor("opaque")).toBe(0);
  });

  it("re-reads audiences after invalidation (resource change)", async () => {
    await verifyBearerAccessToken("tok.a.jwt");
    expect(callsFor("resources")).toBe(1);
    invalidateAudiencesCache();
    await verifyBearerAccessToken("tok.a.jwt");
    expect(callsFor("resources")).toBe(2);
  });

  it("keeps serving cached audiences across sequential verifications", async () => {
    await verifyBearerAccessToken("tok.a.jwt");
    await verifyBearerAccessToken("tok.a.jwt");
    await verifyBearerAccessToken("tok.a.jwt");
    expect(callsFor("resources")).toBe(1);
  });

  it("passes the accepted audiences to the verifier", async () => {
    await verifyBearerAccessToken("tok.a.jwt");

    const [, opts] = verifyImpl.mock.calls[0] as [unknown, VerifyOpts];
    expect(opts.verifyOptions?.audience).toContain(RESOURCE.identifier);
  });

  it("rejects a token whose audience is not in the cached list", async () => {
    verifyImpl.mockImplementation(
      async (_token: unknown, opts?: VerifyOpts) => {
        const accepted = opts?.verifyOptions?.audience ?? [];
        const audience = ["https://other.example"];
        if (audience.some((value) => !accepted.includes(value))) {
          throw new Error("audience mismatch");
        }
        return payload({ aud: audience });
      },
    );

    await expect(verifyBearerAccessToken("tok.a.jwt")).resolves.toBeNull();
  });

  it("still treats opaque tokens live and fails closed on DB misses", async () => {
    await expect(verifyBearerAccessToken("not-a-jwt")).resolves.toBeNull();
    expect(callsFor("opaque")).toBe(1);
    expect(callsFor("resources")).toBe(0);
  });
});
