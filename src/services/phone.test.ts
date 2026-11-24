import { describe, expect, it } from "vitest";
import { normalizePhoneNumber, phoneNumberSchema } from "./phone.js";

describe("normalizePhoneNumber", () => {
  it("strips spaces, dots, dashes, slashes and parentheses", () => {
    expect(normalizePhoneNumber("+33 6 12 34 56 78")).toBe("+33612345678");
    expect(normalizePhoneNumber("06.12.34.56.78")).toBe("0612345678");
    expect(normalizePhoneNumber("06-12-34-56-78")).toBe("0612345678");
    expect(normalizePhoneNumber("(06) 12/34/56/78")).toBe("0612345678");
  });

  it("turns an international 00 prefix into +", () => {
    expect(normalizePhoneNumber("0033 6 12 34 56 78")).toBe("+33612345678");
  });

  it("rejects values that cannot be a phone number", () => {
    expect(normalizePhoneNumber("not a phone")).toBeNull();
    expect(normalizePhoneNumber("+33 6 12")).toBeNull();
    expect(normalizePhoneNumber("1234567890123456")).toBeNull();
  });
});

describe("phoneNumberSchema", () => {
  it("normalises optional values and maps empty input to null", () => {
    expect(phoneNumberSchema.parse(" 06.12.34.56.78 ")).toBe("0612345678");
    expect(phoneNumberSchema.parse("")).toBeNull();
    expect(phoneNumberSchema.parse(null)).toBeNull();
    expect(phoneNumberSchema.parse(undefined)).toBeUndefined();
  });

  it("fails loud on an invalid number", () => {
    expect(() => phoneNumberSchema.parse("123")).toThrow();
  });
});
