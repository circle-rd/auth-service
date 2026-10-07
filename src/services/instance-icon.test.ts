import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const AUTH_PAGES = [
  "login.html",
  "register.html",
  "verify-email.html",
  "email-verified.html",
  "two-factor.html",
  "select-org.html",
  "device.html",
];

// index.html used to point at /favicon.svg with no such file in the tree: the
// icon was a 404 on every deployment. These assertions fail if a head reference
// ever outlives its asset again.
describe("instance icon: index.html references only assets that ship", () => {
  const indexHtml = readFileSync(join(root, "frontend", "index.html"), "utf-8");
  const head = indexHtml.slice(0, indexHtml.indexOf("</head>"));

  const referenced = [
    ...new Set(
      [...head.matchAll(/(?:href|content)="(\/[^"]+)"/g)].map((m) => m[1]),
    ),
  ].filter((url) => !url.startsWith("/src/"));

  it("has at least one local reference to check", () => {
    expect(referenced.length).toBeGreaterThan(0);
  });

  it.each(referenced)("%s exists under frontend/public", (url) => {
    const file = join(root, "frontend", "public", url.slice(1));
    expect(existsSync(file), `${url} is referenced but missing`).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(0);
  });

  it("declares a theme-switching favicon with a dark colourway", () => {
    const svg = readFileSync(
      join(root, "frontend", "public", "favicon.svg"),
      "utf-8",
    );
    expect(svg).toContain("prefers-color-scheme: dark");
    // Two colourways: the light-scheme ink and the dark-scheme ink.
    const fills = [...svg.matchAll(/fill:\s*(#[0-9a-fA-F]{6})/g)].map((m) =>
      m[1].toLowerCase(),
    );
    expect(new Set(fills).size).toBeGreaterThanOrEqual(2);
  });
});

describe("instance icon: built-in auth pages carry the icon", () => {
  it.each(AUTH_PAGES)("%s links the icon set", (page) => {
    const html = readFileSync(
      join(root, "templates", "default", page),
      "utf-8",
    );
    expect(html).toContain('rel="icon"');
    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('href="/site.webmanifest"');
  });

  it.each(AUTH_PAGES)(
    "%s builds an absolute og:image from AUTH_URL",
    (page) => {
      const html = readFileSync(
        join(root, "templates", "default", page),
        "utf-8",
      );
      // The SPA cannot know the instance origin at build time; the server-rendered
      // pages can, so the preview card is only absolute here.
      expect(html).toContain('property="og:image" content="<%= it.AUTH_URL %>');
    },
  );
});

// APP_LOGO_URL must keep overriding the served icon at runtime.
describe("instance icon: APP_LOGO_URL still overrides at runtime", () => {
  const composable = readFileSync(
    join(root, "frontend", "src", "composables", "useAppBranding.ts"),
    "utf-8",
  );

  it("removes every existing icon link before adding the operator's", () => {
    expect(composable).toContain('link[rel~="icon"]');
    expect(composable).toContain(".remove()");
    expect(composable).toMatch(/link\.rel = ["']icon["']/);
  });
});
