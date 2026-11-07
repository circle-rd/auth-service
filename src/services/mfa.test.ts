import { describe, it, expect } from "vitest";
import { deriveMfaState, readMfaState, userMustSetupMfa } from "./mfa.js";

describe("services/mfa", () => {
  describe("deriveMfaState", () => {
    it("reports no methods when neither factor exists", () => {
      expect(deriveMfaState(false, 0)).toEqual({
        totpRegistered: false,
        passkeyCount: 0,
        methods: [],
        mfaEnabled: false,
      });
    });

    it("treats TOTP as an MFA method", () => {
      expect(deriveMfaState(true, 0)).toEqual({
        totpRegistered: true,
        passkeyCount: 0,
        methods: ["totp"],
        mfaEnabled: true,
      });
    });

    it("treats passkeys as an MFA method when a password exists", () => {
      expect(deriveMfaState(false, 2)).toEqual({
        totpRegistered: false,
        passkeyCount: 2,
        methods: ["passkey"],
        mfaEnabled: true,
      });
    });

    it("keeps passkeys as primary-only without a password", () => {
      expect(deriveMfaState(false, 2, false)).toEqual({
        totpRegistered: false,
        passkeyCount: 2,
        methods: [],
        mfaEnabled: false,
      });
    });

    it("does not count a primary passkey as a remaining MFA factor", () => {
      expect(deriveMfaState(true, 1, false)).toEqual({
        totpRegistered: true,
        passkeyCount: 1,
        methods: ["totp"],
        mfaEnabled: true,
      });
    });

    it("reports both methods in a stable order", () => {
      expect(deriveMfaState(true, 1)).toEqual({
        totpRegistered: true,
        passkeyCount: 1,
        methods: ["totp", "passkey"],
        mfaEnabled: true,
      });
    });
  });

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
        userMustSetupMfa(
          { isMfaRequired: false, twoFactorEnabled: true },
          false,
        ),
      ).toBe(false);
    });

    it("returns true when the application requires MFA and 2FA is not set up", () => {
      expect(
        userMustSetupMfa(
          { isMfaRequired: false, twoFactorEnabled: false },
          true,
        ),
      ).toBe(true);
    });

    it("returns true when the user is individually flagged and 2FA is not set up", () => {
      expect(
        userMustSetupMfa(
          { isMfaRequired: true, twoFactorEnabled: false },
          false,
        ),
      ).toBe(true);
    });

    it("returns false when neither flag is set", () => {
      expect(
        userMustSetupMfa(
          { isMfaRequired: false, twoFactorEnabled: false },
          false,
        ),
      ).toBe(false);
    });
  });
});
