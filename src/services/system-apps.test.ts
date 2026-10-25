import { describe, it, expect } from "vitest";
import { presentUserApplications } from "./system-apps.js";

const row = (slug: string, name: string, isSystem = false) => ({
  slug,
  name,
  isSystem,
  id: `id-${slug}`,
});

describe("presentUserApplications", () => {
  it("keeps regular applications untouched and drops the isSystem flag", () => {
    expect(presentUserApplications([row("chat", "Chat")])).toEqual([
      { slug: "chat", name: "Chat", id: "id-chat" },
    ]);
  });

  it("hides every system application", () => {
    const rows = [
      row("litellm", "LiteLLM gateway", true),
      row("litellm-wallet", "LiteLLM wallet", true),
      row("auth-service", "Auth Service API", true),
      row("chat", "Chat"),
    ];
    expect(presentUserApplications(rows).map((r) => r.slug)).toEqual(["chat"]);
  });

  it("stands for the gateway with one LiteLLM entry when the user has the admin interface", () => {
    const rows = [
      row("litellm-ui", "LiteLLM admin interface", true),
      row("chat", "Chat"),
    ];
    expect(presentUserApplications(rows)).toEqual([
      { slug: "litellm-ui", name: "LiteLLM", id: "id-litellm-ui" },
      { slug: "chat", name: "Chat", id: "id-chat" },
    ]);
  });

  it("shows no LiteLLM entry to a user without the admin interface", () => {
    expect(
      presentUserApplications([row("litellm", "LiteLLM gateway", true)]),
    ).toEqual([]);
  });
});
