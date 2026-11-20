import { describe, expect, it } from "vitest";
import { isRelayDeclaration } from "./provenance.js";

const relayObject = {
  managedBy: "reverse-relay",
  clientId: "bmz",
  reverseName: "bmz/qwen3.8",
};

describe("isRelayDeclaration", () => {
  it("accepts an object the relay wrote for the declaring account", () => {
    expect(isRelayDeclaration(relayObject, "bmz/qwen3.8", "bmz")).toBe(true);
  });

  it("rejects an object that another account declares", () => {
    expect(isRelayDeclaration(relayObject, "bmz/qwen3.8", "alice")).toBe(false);
  });

  it("rejects a native LiteLLM object, whatever its created_by says", () => {
    expect(isRelayDeclaration({ createdBy: "bmz" }, "bmz/qwen3.8", "bmz")).toBe(
      false,
    );
  });

  it("rejects a relay object whose reverse name does not match its own name", () => {
    expect(
      isRelayDeclaration(
        { ...relayObject, reverseName: "bmz/other" },
        "bmz/qwen3.8",
        "bmz",
      ),
    ).toBe(false);
  });

  it("rejects an empty username", () => {
    expect(
      isRelayDeclaration(
        { managedBy: "reverse-relay", clientId: "", reverseName: "/x" },
        "/x",
        "",
      ),
    ).toBe(false);
  });
});
