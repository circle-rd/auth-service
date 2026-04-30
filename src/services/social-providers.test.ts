import { describe, it, expect } from "vitest";
import { isSocialProviderAllowed } from "./social-providers.js";

describe("isSocialProviderAllowed", () => {
  it("allows credential provider regardless of config", () => {
    expect(isSocialProviderAllowed(null, "credential")).toBe(true);
    expect(isSocialProviderAllowed([], "credential")).toBe(true);
    expect(isSocialProviderAllowed(["google"], "credential")).toBe(true);
  });

  it("inherits globals when null/undefined (allows everything)", () => {
    expect(isSocialProviderAllowed(null, "google")).toBe(true);
    expect(isSocialProviderAllowed(undefined, "github")).toBe(true);
  });

  it("blocks all social providers when empty array", () => {
    expect(isSocialProviderAllowed([], "google")).toBe(false);
    expect(isSocialProviderAllowed([], "github")).toBe(false);
  });

  it("treats non-empty array as allow-list", () => {
    expect(isSocialProviderAllowed(["google"], "google")).toBe(true);
    expect(isSocialProviderAllowed(["google"], "github")).toBe(false);
    expect(isSocialProviderAllowed(["google", "github"], "github")).toBe(true);
  });
});
