import { describe, expect, it } from "vitest";
import { profileFieldsSchema } from "./profile-fields.js";

describe("profileFieldsSchema", () => {
  it("accepts the optional OpenID Connect profile fields", () => {
    const parsed = profileFieldsSchema.parse({
      middleName: "B.",
      profileUrl: "https://example.com/alice",
      website: "https://alice.example",
      gender: "female",
      birthdate: "1990-01-31",
      zoneinfo: "Europe/Paris",
      locale: "fr-FR",
    });

    expect(parsed).toMatchObject({
      middleName: "B.",
      profileUrl: "https://example.com/alice",
      website: "https://alice.example",
      gender: "female",
      birthdate: "1990-01-31",
      zoneinfo: "Europe/Paris",
      locale: "fr-FR",
    });
  });

  it.each(["1990", "0000", "0000-01-31"])(
    "accepts birthdate %s",
    (birthdate) => {
      expect(profileFieldsSchema.parse({ birthdate }).birthdate).toBe(
        birthdate,
      );
    },
  );

  it.each(["31-01-1990", "1990-13-01", "1990-02-31", "unknown"])(
    "rejects birthdate %s",
    (birthdate) => {
      expect(profileFieldsSchema.safeParse({ birthdate }).success).toBe(false);
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "file:///etc/passwd",
    "https://user:pass@example.com/a.png",
  ])("rejects unsafe avatar/profile URL %s", (url) => {
    expect(profileFieldsSchema.safeParse({ image: url }).success).toBe(false);
    expect(profileFieldsSchema.safeParse({ profileUrl: url }).success).toBe(
      false,
    );
    expect(profileFieldsSchema.safeParse({ website: url }).success).toBe(false);
  });

  it("accepts http and https URLs", () => {
    expect(
      profileFieldsSchema.parse({ image: "https://example.com/a.png" }).image,
    ).toBe("https://example.com/a.png");
    expect(
      profileFieldsSchema.parse({ website: "http://example.com" }).website,
    ).toBe("http://example.com");
  });

  it("accepts free-form gender values and rejects a malformed locale", () => {
    expect(
      profileFieldsSchema.safeParse({ gender: "non-binary" }).success,
    ).toBe(true);
    expect(
      profileFieldsSchema.safeParse({ gender: "x".repeat(101) }).success,
    ).toBe(false);
    expect(profileFieldsSchema.safeParse({ locale: "fr FR" }).success).toBe(
      false,
    );
  });
});
