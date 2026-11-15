import { describe, expect, it } from "vitest";
import {
  assertApplicationSchemeName,
  builtinSchemeRows,
  BUILTIN_SCHEMES,
  isBuiltinScheme,
} from "./schemes.js";
import {
  assertLocator,
  assertResourceScheme,
  buildResourceUri,
  isResourceUri,
  parseResourceUri,
} from "./uri.js";

describe("resource URI", () => {
  it.each([
    "gine://project_db_id",
    "llm://acme/gpt-x",
    "agent://acme/analyst",
    "mcp://acme/server-x",
    "mcp://acme/server-x/tool/search",
    "ssh://123e4567-e89b-12d3-a456-426614174000",
    "https://api.example.com/v1/models",
    "file:///srv/reports/q1.pdf",
  ])("parses %s", (uri) => {
    expect(parseResourceUri(uri).uri).toBe(uri);
  });

  it("extracts scheme and locator", () => {
    expect(parseResourceUri("gine://project_db_id")).toEqual({
      scheme: "gine",
      locator: "project_db_id",
      uri: "gine://project_db_id",
    });
  });

  it("rejects malformed or unsafe URIs", () => {
    for (const uri of [
      "",
      "gine:/project",
      "GINE://project",
      "llm://",
      "llm://acme",
      "llm://acme/gpt x",
      "mcp://acme/server-x/tool",
      "ssh://not a uuid",
      "https://",
      "gine://project\nid",
      `gine://${"a".repeat(300)}`,
    ]) {
      expect(isResourceUri(uri)).toBe(false);
    }
  });

  it("validates schemes independently", () => {
    expect(assertResourceScheme("gine")).toBe("gine");
    expect(assertResourceScheme("a1")).toBe("a1");
    for (const scheme of ["", "Gine", "gi-ne", "1gine", "a".repeat(51)]) {
      expect(() => assertResourceScheme(scheme)).toThrow();
    }
  });

  it("builds canonical URIs", () => {
    expect(buildResourceUri("gine", "project_db_id")).toBe(
      "gine://project_db_id",
    );
    expect(() => buildResourceUri("gine", "project id")).toThrow();
  });

  it("keeps the default locator opaque", () => {
    expect(assertLocator("gine", "project_db_id")).toBe("project_db_id");
    expect(assertLocator("gine", "team/project/sub")).toBe("team/project/sub");
    expect(() => assertLocator("gine", "team project")).toThrow();
  });
});

describe("built-in schemes", () => {
  it("mirrors enabled schemes and disables the others", () => {
    const rows = builtinSchemeRows(["llm", "ssh"]);
    expect(rows.find((row) => row.scheme === "llm")?.status).toBe("active");
    expect(rows.find((row) => row.scheme === "ssh")?.status).toBe("active");
    expect(rows.find((row) => row.scheme === "mcp")?.status).toBe("disabled");
  });

  it("contains the documented schemes", () => {
    expect(BUILTIN_SCHEMES.map((entry) => entry.scheme)).toEqual([
      "llm",
      "agent",
      "mcp",
      "ssh",
      "https",
      "file",
    ]);
    expect(isBuiltinScheme("llm")).toBe(true);
    expect(isBuiltinScheme("gine")).toBe(false);
  });

  it("rejects built-in names for application schemes", () => {
    expect(assertApplicationSchemeName("gine")).toBe("gine");
    expect(() => assertApplicationSchemeName("llm")).toThrow();
  });
});
