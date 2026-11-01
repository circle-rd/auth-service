import { describe, expect, it } from "vitest";
import { httpUrlOrNull, isHttpsUrl } from "./urls.js";

describe("isHttpsUrl", () => {
  it("accepts only https links", () => {
    expect(isHttpsUrl("https://example.com")).toBe(true);
    expect(isHttpsUrl("http://example.com")).toBe(false);
    expect(isHttpsUrl(null)).toBe(false);
  });
});

describe("httpUrlOrNull", () => {
  it("keeps an absolute http(s) URL verbatim", () => {
    expect(httpUrlOrNull("https://example.com/logo.png")).toBe(
      "https://example.com/logo.png",
    );
    expect(httpUrlOrNull("http://example.com")).toBe("http://example.com");
  });

  it("rejects relative, malformed and non-web values", () => {
    expect(httpUrlOrNull("/logo.png")).toBeNull();
    expect(httpUrlOrNull("not a url")).toBeNull();
    expect(httpUrlOrNull("ftp://example.com/logo.png")).toBeNull();
    expect(httpUrlOrNull(null)).toBeNull();
  });
});
