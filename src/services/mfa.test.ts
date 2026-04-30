import { describe, it, expect } from "vitest";
import { readMfaState, userMustSetupMfa } from "./mfa.js";

describe("services/mfa", () => {
  describe("readMfaState", () => {
    it("coerces undefined fields to false", () => {
      expect(readMfaState({})).toEqual({
        isMfaRequired: false,
        twoFactorEnabled: false,
      });
    });

    it("returns truthy values as booleans", () => {
      expect(
        readMfaState({ isMfaRequired: true, twoFactorEnabled: 1 }),
      ).toEqual({ isMfaRequired: true, twoFactorEnabled: true });
    });
  });

  describe("userMustSetupMfa", () => {
    it("returns false when user has 2FA enabled regardless of flags", () => {
      expect(
        userMustSetupMfa({ isMfaRequired: true, twoFactorEnabled: true }, true),
      ).toBe(false);
      expect(
        userMustSetupMfa({ isMfaRequired: false, twoFactorEnabled: true }, false),
      ).toBe(false);
    });

    it("returns true when the application requires MFA and 2FA is not set up", () => {
      expect(
        userMustSetupMfa({ isMfaRequired: false, twoFactorEnabled: false }, true),
      ).toBe(true);
    });

    it("returns true when the user is individually flagged and 2FA is not set up", () => {
      expect(
        userMustSetupMfa({ isMfaRequired: true, twoFactorEnabled: false }, false),
      ).toBe(true);
    });

    it("returns false when neither flag is set", () => {
      expect(
        userMustSetupMfa({ isMfaRequired: false, twoFactorEnabled: false }, false),
      ).toBe(false);
    });
  });
});
