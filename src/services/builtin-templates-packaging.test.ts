import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The resolvers fall back to <app>/templates/default (relative to the compiled
// dist/services). If the runtime image does not ship that directory, any
// TEMPLATES_DIR volume lacking a `default/` folder breaks email delivery.
describe("Dockerfile ships built-in templates", () => {
  it("copies templates/default into the runtime image", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf-8");
    expect(dockerfile).toMatch(
      /COPY\s+templates\/default\s+\.\/templates\/default/,
    );
  });

  it("has the source directory and every built-in email template", () => {
    for (const name of [
      "verify-email",
      "reset-password",
      "magic-link",
      "email-otp",
      "change-email",
      "org-invitation",
    ]) {
      expect(
        existsSync(join(root, "templates", "default", "emails", `${name}.eml`)),
      ).toBe(true);
    }
    expect(existsSync(join(root, "templates", "default", "login.html"))).toBe(
      true,
    );
  });
});
