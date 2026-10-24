import { describe, it, expect } from "vitest";
import {
  claimMappingsSchema,
  compatExtraScopes,
  resolveCompat,
} from "./profiles.js";
import { NATIVE_SCOPES } from "./scopes.js";

describe("resolveCompat", () => {
  it("keeps the current behaviour for the default profile", () => {
    expect(resolveCompat({ profile: "default" })).toEqual({
      profile: "default",
      tokenAuthMethod: "basic",
      signingAlg: "EdDSA",
      defaultAudience: false,
      audienceParam: false,
      claimMappings: [],
      aliases: [],
    });
  });

  it("applies the okta and auth0 presets", () => {
    const okta = resolveCompat({ profile: "okta" });
    expect(okta).toMatchObject({
      tokenAuthMethod: "basic",
      signingAlg: "RS256",
      defaultAudience: true,
      aliases: ["okta"],
    });
    expect(okta.claimMappings.map((m) => m.claim)).toEqual([
      "groups",
      "scp",
      "preferred_username",
      "cid",
    ]);

    expect(resolveCompat({ profile: "auth0" })).toMatchObject({
      tokenAuthMethod: "post",
      signingAlg: "RS256",
      audienceParam: true,
      defaultAudience: false,
    });
  });

  it("lets an explicit setting win over the profile", () => {
    const settings = resolveCompat({
      profile: "okta",
      tokenAuthMethod: "post",
      signingAlg: "EdDSA",
      defaultAudience: false,
      claimMappings: [],
    });
    expect(settings).toMatchObject({
      tokenAuthMethod: "post",
      signingAlg: "EdDSA",
      defaultAudience: false,
      claimMappings: [],
    });
  });

  it("starts from the plain defaults for the custom profile", () => {
    expect(resolveCompat({ profile: "custom", audienceParam: true })).toEqual({
      profile: "custom",
      tokenAuthMethod: "basic",
      signingAlg: "EdDSA",
      defaultAudience: false,
      audienceParam: true,
      claimMappings: [],
      aliases: [],
    });
  });
});

describe("claimMappingsSchema", () => {
  it("accepts a namespaced claim", () => {
    const parsed = claimMappingsSchema.parse([
      { claim: "https://acme.example/roles", source: "roles" },
    ]);
    expect(parsed).toHaveLength(1);
  });

  it.each(["sub", "aud", "azp", "scope", "exp"])(
    "refuses the protected claim %s",
    (claim) => {
      expect(
        claimMappingsSchema.safeParse([{ claim, source: "roles" }]).success,
      ).toBe(false);
    },
  );

  it("refuses an unknown source and an invalid name", () => {
    expect(
      claimMappingsSchema.safeParse([{ claim: "x", source: "password" }])
        .success,
    ).toBe(false);
    expect(
      claimMappingsSchema.safeParse([{ claim: "bad name", source: "roles" }])
        .success,
    ).toBe(false);
  });
});

describe("compatExtraScopes", () => {
  it("returns only the scopes the server does not support natively", () => {
    const okta = resolveCompat({ profile: "okta" });
    expect(compatExtraScopes(okta, NATIVE_SCOPES)).toEqual(["groups"]);
    expect(
      compatExtraScopes(resolveCompat({ profile: "keycloak" }), NATIVE_SCOPES),
    ).toEqual([]);
  });
});
