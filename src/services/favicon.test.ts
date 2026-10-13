import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { assertPublicHost } = vi.hoisted(() => ({
  assertPublicHost: vi.fn(async (_host: string): Promise<void> => undefined),
}));
vi.mock("./outbound-guard.js", () => ({ assertPublicHost }));

import { declaredIcons, detectFavicon } from "./favicon.js";

const PAGE = "https://app.example.com/dashboard/";

describe("declaredIcons", () => {
  it("resolves relative hrefs and ranks vector, then larger, then apple icons", () => {
    const html = `<html><head>
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel="shortcut icon" href="legacy.ico">
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" type="image/png" sizes="64x64" href='/f64.png'>
      <link rel="icon" type="image/svg+xml" href="/logo.svg">
      <link rel="stylesheet" href="/app.css">
      <link rel="mask-icon" href="/mask.svg">
      <link rel="icon" href="data:image/png;base64,AAAA">
    </head><body><link rel="icon" href="/in-body.png"></body></html>`;
    expect(declaredIcons(html, PAGE)).toEqual([
      "https://app.example.com/logo.svg",
      "https://app.example.com/apple.png",
      "https://app.example.com/f64.png",
      "https://app.example.com/favicon-16.png",
      "https://app.example.com/dashboard/legacy.ico",
    ]);
  });

  it("honours <base href>", () => {
    const html = `<head><base href="https://cdn.example.com/static/"><link rel="icon" href="i.png"></head>`;
    expect(declaredIcons(html, PAGE)).toEqual([
      "https://cdn.example.com/static/i.png",
    ]);
  });

  it("returns nothing for a page without icons", () => {
    expect(declaredIcons("<head><title>x</title></head>", PAGE)).toEqual([]);
  });
});

function respond(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string) => {
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  });
}

const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html" } });
const image = (type = "image/png") =>
  new Response("img", { headers: { "content-type": type } });

describe("detectFavicon", () => {
  beforeEach(() => {
    assertPublicHost.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the best declared icon that really is an image", async () => {
    vi.stubGlobal(
      "fetch",
      respond({
        [PAGE]: () =>
          html(
            `<head><link rel="icon" href="/logo.svg" type="image/svg+xml"><link rel="icon" href="/f.png" sizes="32x32"></head>`,
          ),
        "https://app.example.com/logo.svg": () => image("image/svg+xml"),
      }),
    );
    expect(await detectFavicon(PAGE)).toBe("https://app.example.com/logo.svg");
  });

  it("skips a declared icon that does not answer and takes the next one", async () => {
    vi.stubGlobal(
      "fetch",
      respond({
        [PAGE]: () =>
          html(
            `<head><link rel="icon" href="/missing.svg"><link rel="icon" href="/f.png" sizes="32x32"></head>`,
          ),
        "https://app.example.com/f.png": () => image(),
      }),
    );
    expect(await detectFavicon(PAGE)).toBe("https://app.example.com/f.png");
  });

  it("falls back to /favicon.ico on the origin the page redirected to", async () => {
    vi.stubGlobal(
      "fetch",
      respond({
        [PAGE]: () =>
          new Response(null, {
            status: 301,
            headers: { location: "https://www.example.com/home" },
          }),
        "https://www.example.com/home": () => html("<head></head>"),
        "https://www.example.com/favicon.ico": () => image("image/x-icon"),
      }),
    );
    expect(await detectFavicon(PAGE)).toBe(
      "https://www.example.com/favicon.ico",
    );
  });

  it("is null when nothing is found, and for a URL that is not http(s)", async () => {
    vi.stubGlobal("fetch", respond({ [PAGE]: () => html("<head></head>") }));
    expect(await detectFavicon(PAGE)).toBeNull();
    expect(await detectFavicon("ftp://app.example.com")).toBeNull();
    expect(await detectFavicon("not a url")).toBeNull();
  });

  it("never fetches a host the SSRF guard refuses", async () => {
    assertPublicHost.mockImplementation(async () => {
      throw new Error("blocked address: 10.0.0.5");
    });
    const fetchMock = respond({});
    vi.stubGlobal("fetch", fetchMock);
    expect(await detectFavicon("http://10.0.0.5/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not trust a redirect to a private host", async () => {
    assertPublicHost.mockImplementation(async (host: string) => {
      if (host === "internal.lan") throw new Error("blocked host");
    });
    const fetchMock = respond({
      [PAGE]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://internal.lan/" },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await detectFavicon(PAGE)).toBeNull();
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain(
      "http://internal.lan/",
    );
  });
});
