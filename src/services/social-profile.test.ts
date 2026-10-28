import { describe, expect, it } from "vitest";
import {
  mapGitHubProfile,
  mapGoogleProfile,
  splitFullName,
} from "./social-profile.js";

describe("splitFullName", () => {
  it("keeps a single token as the first name", () => {
    expect(splitFullName("Ada")).toEqual({ firstName: "Ada" });
  });

  it("treats every token after the first as the last name", () => {
    expect(splitFullName("Ada Lovelace Byron")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace Byron",
    });
  });

  it("returns nothing for an empty name", () => {
    expect(splitFullName(undefined)).toEqual({});
    expect(splitFullName("   ")).toEqual({});
  });
});

describe("mapGoogleProfile", () => {
  it("maps the standard OIDC given_name and family_name claims", () => {
    expect(
      mapGoogleProfile({
        name: "Ada Lovelace",
        given_name: "Ada",
        family_name: "Lovelace",
        picture: "https://example.com/ada.png",
        email: "ada@example.com",
      }),
    ).toEqual({
      name: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("rebuilds the display name when Google omits name", () => {
    expect(
      mapGoogleProfile({ given_name: "Ada", family_name: "Lovelace" }),
    ).toEqual({ name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" });
  });

  it("never invents fields Google does not return", () => {
    expect(mapGoogleProfile({ sub: "123" })).toEqual({});
  });
});

describe("mapGitHubProfile", () => {
  it("maps the username and company, stripping the GitHub @ prefix", () => {
    expect(
      mapGitHubProfile({
        login: "ada",
        name: "Ada Lovelace",
        company: "@analytical-engines",
      }),
    ).toEqual({
      name: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      username: "ada",
      company: "analytical-engines",
    });
  });

  it("falls back to the login when GitHub has no display name", () => {
    expect(mapGitHubProfile({ login: "octocat", name: null })).toEqual({
      username: "octocat",
    });
  });

  it("does not turn GitHub location into a postal address", () => {
    const mapped = mapGitHubProfile({
      login: "ada",
      location: "London, United Kingdom",
    });
    expect(mapped).not.toHaveProperty("address");
    expect(mapped).not.toHaveProperty("city");
    expect(mapped).not.toHaveProperty("country");
  });
});
