import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = vi.hoisted(() => ({
  compat: { defaultAudience: false, audienceParam: false },
}));
vi.mock("../config.js", () => ({ config: settings }));
vi.mock("../db/index.js", () => ({ db: {} }));

import { resolveAudiencePatch } from "./audience.js";

const lookup = vi.fn<(slug: string) => Promise<string | null>>();

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue("https://app.example.com");
  settings.compat.defaultAudience = false;
  settings.compat.audienceParam = false;
});

const basic = (id: string) =>
  new Headers({
    authorization: "Basic " + Buffer.from(`${id}:secret`).toString("base64"),
  });

describe("resolveAudiencePatch", () => {
  it("does nothing when both settings are off", async () => {
    expect(
      await resolveAudiencePatch(
        { path: "/oauth2/authorize", query: { client_id: "app" } },
        lookup,
      ),
    ).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("gives an authorization request the client's url as resource", async () => {
    settings.compat.defaultAudience = true;
    const patch = await resolveAudiencePatch(
      { path: "/oauth2/authorize", method: "GET", query: { client_id: "app" } },
      lookup,
    );
    expect(patch).toEqual({
      context: { query: { resource: "https://app.example.com" } },
    });
    expect(lookup).toHaveBeenCalledWith("app");
  });

  it("targets the body of a POST authorization request", async () => {
    settings.compat.defaultAudience = true;
    const patch = await resolveAudiencePatch(
      { path: "/oauth2/authorize", method: "POST", body: { client_id: "app" } },
      lookup,
    );
    expect(patch).toEqual({
      context: { body: { resource: "https://app.example.com" } },
    });
  });

  it("never overrides a resource the client sent", async () => {
    settings.compat.defaultAudience = true;
    settings.compat.audienceParam = true;
    expect(
      await resolveAudiencePatch(
        {
          path: "/oauth2/authorize",
          query: {
            client_id: "app",
            resource: "https://other.example.com",
            audience: "https://x.example.com",
          },
        },
        lookup,
      ),
    ).toBeUndefined();
  });

  it("maps `audience` to `resource` without a lookup", async () => {
    settings.compat.audienceParam = true;
    const patch = await resolveAudiencePatch(
      {
        path: "/oauth2/authorize",
        query: { client_id: "app", audience: "https://api.example.com" },
      },
      lookup,
    );
    expect(patch).toEqual({
      context: { query: { resource: "https://api.example.com" } },
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("defaults the resource of a client_credentials grant from Basic credentials", async () => {
    settings.compat.defaultAudience = true;
    const patch = await resolveAudiencePatch(
      {
        path: "/oauth2/token",
        body: { grant_type: "client_credentials" },
        headers: basic("m2m"),
      },
      lookup,
    );
    expect(patch).toEqual({
      context: { body: { resource: "https://app.example.com" } },
    });
    expect(lookup).toHaveBeenCalledWith("m2m");
  });

  it("does not default the resource of a code exchange or a refresh", async () => {
    settings.compat.defaultAudience = true;
    for (const grant_type of ["authorization_code", "refresh_token"]) {
      expect(
        await resolveAudiencePatch(
          { path: "/oauth2/token", body: { grant_type, client_id: "app" } },
          lookup,
        ),
      ).toBeUndefined();
    }
  });

  it("leaves other endpoints alone and ignores an unknown client", async () => {
    settings.compat.defaultAudience = true;
    expect(
      await resolveAudiencePatch({ path: "/sign-in/email" }, lookup),
    ).toBeUndefined();
    lookup.mockResolvedValue(null);
    expect(
      await resolveAudiencePatch(
        { path: "/oauth2/authorize", query: { client_id: "ghost" } },
        lookup,
      ),
    ).toBeUndefined();
  });
});
