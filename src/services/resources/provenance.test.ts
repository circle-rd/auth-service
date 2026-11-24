import { describe, expect, it } from "vitest";
import { isRelayDeclaration } from "./provenance.js";

const relayObject = {
  managedBy: "reverse-relay",
  clientId: "u-bmz",
  reverseName: "u-bmz/qwen3.8",
};

describe("isRelayDeclaration", () => {
  it("accepts an object the relay wrote for the declaring user's namespace", () => {
    expect(isRelayDeclaration(relayObject, "u-bmz/qwen3.8", "bmz")).toBe(true);
    expect(isRelayDeclaration(relayObject, "u-bmz/qwen3.8", "BMZ")).toBe(true);
  });

  it("rejects an object that another account declares", () => {
    expect(isRelayDeclaration(relayObject, "u-bmz/qwen3.8", "alice")).toBe(
      false,
    );
  });

  it("rejects a relay object that is not in a user namespace", () => {
    const plain = { ...relayObject, clientId: "bmz", reverseName: "bmz/qwen" };
    expect(isRelayDeclaration(plain, "bmz/qwen", "bmz")).toBe(false);
  });

  it("does not match a longer username that merely starts with the same letters", () => {
    const longer = {
      ...relayObject,
      clientId: "u-bmz2",
      reverseName: "u-bmz2/m",
    };
    expect(isRelayDeclaration(longer, "u-bmz2/m", "bmz")).toBe(false);
  });

  it("rejects a native LiteLLM object, whatever its created_by says", () => {
    expect(
      isRelayDeclaration({ createdBy: "u-bmz" }, "u-bmz/qwen3.8", "bmz"),
    ).toBe(false);
  });

  it("rejects a relay object whose reverse name does not match its own name", () => {
    expect(
      isRelayDeclaration(
        { ...relayObject, reverseName: "u-bmz/other" },
        "u-bmz/qwen3.8",
        "bmz",
      ),
    ).toBe(false);
  });

  it("rejects an empty username", () => {
    expect(
      isRelayDeclaration(
        { managedBy: "reverse-relay", clientId: "u-", reverseName: "u-/x" },
        "u-/x",
        "",
      ),
    ).toBe(false);
  });
});
