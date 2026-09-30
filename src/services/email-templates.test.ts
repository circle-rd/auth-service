import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderEmail, resolveEmailTemplate } from "./email-templates.js";

describe("renderEmail", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "email-templates-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTemplate(
    appSlug: string | null,
    name: string,
    content: string,
  ): void {
    const base = appSlug
      ? join(dir, appSlug, "emails")
      : join(dir, "default", "emails");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, `${name}.eml`), content);
  }

  it("renders subject, html, and text sections with Eta", () => {
    writeTemplate(
      null,
      "welcome",
      `---
subject: Hello <%= it.name %>
---
<p>Welcome <%= it.name %>!</p>
===TEXT===
Welcome <%= it.name %>!
`,
    );

    const out = renderEmail("welcome", { name: "Alice" }, null, dir);
    expect(out.subject).toBe("Hello Alice");
    expect(out.html).toContain("Welcome Alice!");
    expect(out.text).toBe("Welcome Alice!");
  });

  it("HTML-escapes user-supplied values in the html section", () => {
    writeTemplate(
      null,
      "esc",
      `---
subject: x
---
<p><%= it.payload %></p>
===TEXT===
<%= it.payload %>
`,
    );

    const out = renderEmail("esc", { payload: '<img onerror=x>' }, null, dir);
    expect(out.html).toContain("&lt;img onerror=x&gt;");
    // Text section also escapes via <%= %>; consumers receive a safe string.
    expect(out.text).toContain("&lt;img onerror=x&gt;");
  });

  it("falls back to a plain-text version of the HTML when text section is missing", () => {
    writeTemplate(
      null,
      "no-text",
      `---
subject: x
---
<p>Hello <strong><%= it.name %></strong>!</p>
`,
    );

    const out = renderEmail("no-text", { name: "Bob" }, null, dir);
    expect(out.text).toContain("Hello Bob!");
    expect(out.text).not.toContain("<strong>");
  });

  it("prefers per-app override over default", () => {
    writeTemplate(
      null,
      "verify-email",
      `---
subject: Default subject
---
<p>default</p>
`,
    );
    writeTemplate(
      "tenant-a",
      "verify-email",
      `---
subject: Tenant A subject
---
<p>tenant a</p>
`,
    );

    const def = renderEmail("verify-email", {}, null, dir);
    const tenant = renderEmail("verify-email", {}, "tenant-a", dir);
    expect(def.subject).toBe("Default subject");
    expect(tenant.subject).toBe("Tenant A subject");
    expect(tenant.html).toContain("tenant a");
  });

  it("falls back to built-in template when no override exists", () => {
    // No external dir, no override — should resolve the bundled built-in.
    const out = renderEmail(
      "verify-email",
      { appName: "Test", url: "https://x.test/verify", expiresInHours: 1 },
      null,
      null,
    );
    expect(out.subject).toContain("Test");
    expect(out.html).toContain("https://x.test/verify");
    expect(out.text).toContain("https://x.test/verify");
  });

  it("throws when the template is missing required frontmatter", () => {
    writeTemplate(null, "broken", `Hello world`);
    expect(() => renderEmail("broken", {}, null, dir)).toThrow(
      /missing the YAML frontmatter/i,
    );
  });

  it("throws when subject is missing", () => {
    writeTemplate(
      null,
      "no-subject",
      `---
from: foo@bar
---
<p>body</p>
`,
    );
    expect(() => renderEmail("no-subject", {}, null, dir)).toThrow(
      /missing a "subject"/i,
    );
  });

  it("resolveEmailTemplate throws a descriptive error for unknown names", () => {
    expect(() => resolveEmailTemplate("does-not-exist", null, null)).toThrow(
      /No email template found/,
    );
  });
});
