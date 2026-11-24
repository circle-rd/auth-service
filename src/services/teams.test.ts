import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {} }));

const { deriveTeamSlug } = await import("./teams.js");

describe("deriveTeamSlug", () => {
  it("normalises accents, case and punctuation, then adds a random suffix", () => {
    expect(deriveTeamSlug("\u00c9quipe  R&D !")).toMatch(
      /^equipe-r-d-[0-9a-f]{6}$/,
    );
  });

  it("keeps the slug within 50 characters without a doubled or trailing hyphen", () => {
    const slug = deriveTeamSlug(`${"a".repeat(41)} bbb`);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug).not.toContain("--");
    expect(slug).toMatch(/^a+-[0-9a-f]{6}$/);
  });

  it("gives two teams with the same name different slugs", () => {
    expect(deriveTeamSlug("Same")).not.toBe(deriveTeamSlug("Same"));
  });

  it("refuses a name that yields no usable character with ORG_003", () => {
    let caught: unknown;
    try {
      deriveTeamSlug("\u4e2d\u6587 ---");
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "ORG_003", statusCode: 400 });
  });
});
