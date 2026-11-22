import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./pg-errors.js";

describe("isUniqueViolation", () => {
  it("recognises SQLSTATE 23505 on the error itself", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("recognises SQLSTATE 23505 on the wrapped driver error", () => {
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
  });

  it("ignores other SQLSTATEs and values that are not errors", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});
