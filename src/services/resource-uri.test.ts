import { describe, expect, it } from "vitest";
import { ApiError } from "../errors.js";
import {
  formatResourceUri,
  normalizeResourceKey,
  normalizeResourceSlug,
  parseResourceUri,
  resourceTypeForScheme,
  schemeForResourceType,
} from "./resource-uri.js";

function rejection(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected a rejection");
}

describe("normalizeResourceKey", () => {
  it("accepts the canonical owner/slug form", () => {
    expect(normalizeResourceKey("app-a/model-a")).toEqual({
      owner: "app-a",
      slug: "model-a",
      key: "app-a/model-a",
    });
  });

  it.each([
    ["", "empty"],
    ["app-a", "missing slug"],
    ["/model-a", "missing owner"],
    ["app-a/", "missing slug"],
    ["app-a/model-a/extra", "extra segment"],
    ["App-A/model-a", "uppercase owner"],
    ["app-a/Model-A", "uppercase slug"],
    ["app-a/../secret", "path traversal"],
    ["app-a/model%2Fa", "encoded slash"],
    ["app-a/model?a", "query"],
    ["app-a/model#a", "fragment"],
    ["https://app-a/model-a", "URI instead of key"],
    ["app-a/model a", "whitespace"],
    ["app-a\\model-a", "backslash"],
    ["---/---", "no alphanumeric slug"],
  ])("rejects %j (%s)", (input) => {
    const error = rejection(() => normalizeResourceKey(input));
    expect(error.code).toBe("RES_005");
    expect(error.statusCode).toBe(400);
  });
});

describe("normalizeResourceSlug", () => {
  it("accepts a lowercase slug", () => {
    expect(normalizeResourceSlug("model-1")).toBe("model-1");
  });

  it.each(["", "Model", "-", "a/b", "a.b"])("rejects %j", (slug) => {
    expect(rejection(() => normalizeResourceSlug(slug)).code).toBe("RES_005");
  });
});

describe("scheme registry", () => {
  it.each([
    ["model", "llm"],
    ["workflow", "workflow"],
    ["mcp_agent", "mcpagent"],
    ["https_endpoint", "api"],
  ] as const)("maps %s to %s", (type, scheme) => {
    expect(schemeForResourceType(type)).toBe(scheme);
    expect(resourceTypeForScheme(scheme)).toBe(type);
  });

  it("does not register transport or reserved schemes in M1", () => {
    expect(resourceTypeForScheme("https")).toBeUndefined();
    expect(resourceTypeForScheme("ssh")).toBeUndefined();
  });
});

describe("parseResourceUri", () => {
  it.each([
    ["llm://app-a/model-a", "model"],
    ["workflow://app-a/flow-a", "workflow"],
    ["mcpagent://app-b/agent-a", "mcp_agent"],
    ["api://app-b/endpoint-a", "https_endpoint"],
  ] as const)("parses %s as %s", (uri, type) => {
    expect(parseResourceUri(uri)).toEqual({
      owner: uri.includes("app-a") ? "app-a" : "app-b",
      slug: uri.split("/")[3],
      key: `${uri.includes("app-a") ? "app-a" : "app-b"}/${uri.split("/")[3]}`,
      resourceType: type,
      scheme: uri.split(":")[0],
      uri,
    });
  });

  it.each([
    ["https://app-a/model-a", "transport URL masquerading as identity"],
    ["ssh://app-a/host-a", "reserved scheme"],
    ["LLM://app-a/model-a", "uppercase scheme"],
    ["llm://App-a/model-a", "uppercase owner"],
    ["llm://app-a/model-a/extra", "extra segment"],
    ["llm://app-a/../model-a", "path traversal"],
    ["llm://app-a/", "missing slug"],
    [" llm://app-a/model-a", "leading whitespace"],
    ["llm://app-a/model-a ", "trailing whitespace"],
    ["llm:app-a/model-a", "missing authority separators"],
  ])("rejects %j (%s)", (uri) => {
    expect(rejection(() => parseResourceUri(uri)).code).toBe("RES_005");
  });
});

describe("formatResourceUri", () => {
  it.each([
    ["model", "app-a/model-a", "llm://app-a/model-a"],
    ["workflow", "app-a/flow-a", "workflow://app-a/flow-a"],
    ["mcp_agent", "app-a/agent-a", "mcpagent://app-a/agent-a"],
    ["https_endpoint", "app-a/api-a", "api://app-a/api-a"],
  ] as const)("formats %s %s", (type, key, uri) => {
    expect(formatResourceUri(type, key)).toBe(uri);
  });

  it("round-trips through parseResourceUri", () => {
    const uri = formatResourceUri("model", "app-a/model-a");
    expect(parseResourceUri(uri).key).toBe("app-a/model-a");
  });

  it("rejects an invalid key", () => {
    expect(
      rejection(() => formatResourceUri("model", "App-A/model-a")).code,
    ).toBe("RES_005");
  });
});
