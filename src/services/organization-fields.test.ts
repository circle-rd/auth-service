import { describe, expect, it } from "vitest";
import { teamFilterSchema } from "./organization-fields.js";

describe("teamFilterSchema", () => {
  it("reads the query string as a boolean", () => {
    expect(teamFilterSchema.parse("true")).toBe(true);
    expect(teamFilterSchema.parse("false")).toBe(false);
  });

  it("refuses any other value", () => {
    expect(teamFilterSchema.safeParse("1").success).toBe(false);
    expect(teamFilterSchema.safeParse("TRUE").success).toBe(false);
  });
});
