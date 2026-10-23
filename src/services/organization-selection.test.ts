import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {} }));

import { resolveOrganization } from "./organization-selection.js";

describe("services/organization-selection", () => {
  describe("resolveOrganization", () => {
    it("needs no organization when the user has none", () => {
      expect(resolveOrganization([], undefined)).toEqual({
        organizationId: undefined,
        selectionRequired: false,
      });
    });

    it("binds the sole organization without a selection", () => {
      expect(resolveOrganization(["org-1"], undefined)).toEqual({
        organizationId: "org-1",
        selectionRequired: false,
      });
    });

    it("ignores a stale active organization when the user has a single one", () => {
      expect(resolveOrganization(["org-1"], "org-gone")).toEqual({
        organizationId: "org-1",
        selectionRequired: false,
      });
    });

    it("requires a selection among several organizations", () => {
      expect(resolveOrganization(["org-1", "org-2"], undefined)).toEqual({
        organizationId: undefined,
        selectionRequired: true,
      });
    });

    it("keeps the active organization among several", () => {
      expect(resolveOrganization(["org-1", "org-2"], "org-2")).toEqual({
        organizationId: "org-2",
        selectionRequired: true,
      });
    });

    it("rejects an active organization the user does not belong to", () => {
      expect(resolveOrganization(["org-1", "org-2"], "org-3")).toEqual({
        organizationId: undefined,
        selectionRequired: true,
      });
    });
  });
});
