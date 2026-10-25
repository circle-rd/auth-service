import { describe, it, expect } from "vitest";
import {
  LAST_USED_LOGIN_METHOD_COOKIE,
  narrowSocialProvidersByLastUsed,
  parseLastUsedLoginMethod,
} from "./last-login-method.js";

describe("parseLastUsedLoginMethod", () => {
  it("returns null without a cookie header", () => {
    expect(parseLastUsedLoginMethod(undefined)).toBeNull();
    expect(parseLastUsedLoginMethod(null)).toBeNull();
    expect(parseLastUsedLoginMethod("")).toBeNull();
  });

  it("extracts the method from a mixed cookie header", () => {
    const header = `other=1; ${LAST_USED_LOGIN_METHOD_COOKIE}=google; session=abc`;
    expect(parseLastUsedLoginMethod(header)).toBe("google");
  });

  it("url-decodes the value", () => {
    const header = `${LAST_USED_LOGIN_METHOD_COOKIE}=magic-link`;
    expect(parseLastUsedLoginMethod(header)).toBe("magic-link");
  });

  it("returns null when the cookie is present but empty", () => {
    expect(
      parseLastUsedLoginMethod(`${LAST_USED_LOGIN_METHOD_COOKIE}=`),
    ).toBeNull();
  });

  it("returns null when the cookie is absent", () => {
    expect(parseLastUsedLoginMethod("other=1; session=abc")).toBeNull();
  });
});

describe("narrowSocialProvidersByLastUsed", () => {
  it("keeps the full list when there is no last-used value", () => {
    expect(narrowSocialProvidersByLastUsed(["google", "github"], null)).toEqual(
      ["google", "github"],
    );
  });

  it("narrows to the last-used provider when it is offered", () => {
    expect(
      narrowSocialProvidersByLastUsed(["google", "github"], "github"),
    ).toEqual(["github"]);
  });

  it("keeps the full list when the last-used method is not social", () => {
    expect(
      narrowSocialProvidersByLastUsed(["google", "github"], "email"),
    ).toEqual(["google", "github"]);
  });

  it("keeps the full list when the last-used provider is not offered", () => {
    expect(narrowSocialProvidersByLastUsed(["github"], "google")).toEqual([
      "github",
    ]);
  });

  it("does not mutate the input list", () => {
    const providers = ["google", "github"];
    narrowSocialProvidersByLastUsed(providers, "github");
    expect(providers).toEqual(["google", "github"]);
  });
});
