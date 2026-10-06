import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAuthPage } from "./templates.js";

// The built-in login/register templates are used (no external templates dir).
const NO_EXTERNAL_DIR = null;

describe("renderAuthPage external volume without default/", () => {
  it("falls back to the built-in page when the volume only holds per-app overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-pages-test-"));
    try {
      mkdirSync(join(dir, "my-app"), { recursive: true });
      writeFileSync(join(dir, "my-app", "login.html"), "<p>custom login</p>");
      const vars = {
        actionUrl: "/a",
        redirectTo: "/r",
        appSlug: "my-app",
        authUrl: "https://auth.example.com",
      };

      expect(renderAuthPage("login", vars, "my-app", dir)).toContain(
        "custom login",
      );
      // register.html is not overridden and the volume has no default/ dir.
      const fallback = renderAuthPage("register", vars, "my-app", dir);
      expect(fallback).toContain("https://auth.example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderAuthPage", () => {
  describe("variable substitution", () => {
    it("substitutes all standard variables", () => {
      const html = renderAuthPage(
        "login",
        {
          actionUrl: "/api/auth/sign-in/email",
          redirectTo: "/dashboard",
          appSlug: "my-app",
          authUrl: "https://auth.example.com",
        },
        null,
        NO_EXTERNAL_DIR,
      );

      expect(html).toContain("/api/auth/sign-in/email");
      expect(html).toContain("/dashboard");
      expect(html).toContain("https://auth.example.com");
    });

    it("renders empty OAUTH_QUERY when oauthQuery is not provided", () => {
      const html = renderAuthPage(
        "login",
        {
          actionUrl: "/api/auth/sign-in/email",
          redirectTo: "/",
          appSlug: "",
          authUrl: "https://auth.example.com",
        },
        null,
        NO_EXTERNAL_DIR,
      );

      // The placeholder must be replaced (not left as literal {{OAUTH_QUERY}})
      expect(html).not.toContain("{{OAUTH_QUERY}}");
      // The hidden input should carry an empty value
      expect(html).toContain('name="oauthQuery" value=""');
    });

    it("renders OAUTH_QUERY when oauthQuery is provided", () => {
      const rawQs =
        "response_type=code&client_id=my-app&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback&scope=openid&exp=9999999999&sig=abc123";

      const html = renderAuthPage(
        "login",
        {
          actionUrl: "/api/auth/sign-in/email",
          redirectTo: "/",
          appSlug: "my-app",
          authUrl: "https://auth.example.com",
          oauthQuery: rawQs,
        },
        null,
        NO_EXTERNAL_DIR,
      );

      expect(html).not.toContain("{{OAUTH_QUERY}}");
      // The raw query string should appear HTML-escaped in the value attribute.
      // "&" becomes "&amp;" so "scope=openid&exp" → "scope=openid&amp;exp"
      expect(html).toContain("scope=openid&amp;exp=9999999999");
    });

    it("HTML-escapes oauthQuery special characters", () => {
      const html = renderAuthPage(
        "login",
        {
          actionUrl: "/api/auth/sign-in/email",
          redirectTo: "/",
          appSlug: "",
          authUrl: "https://auth.example.com",
          oauthQuery: 'a=1&b=<script>"',
        },
        null,
        NO_EXTERNAL_DIR,
      );

      // The dangerous chars must be escaped
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&quot;");
    });

    it("renders empty ERROR_MESSAGE when errorMessage is not provided", () => {
      const html = renderAuthPage(
        "login",
        {
          actionUrl: "/api/auth/sign-in/email",
          redirectTo: "/",
          appSlug: "",
          authUrl: "https://auth.example.com",
        },
        null,
        NO_EXTERNAL_DIR,
      );

      expect(html).not.toContain("{{ERROR_MESSAGE}}");
    });

    it("renders errorMessage when provided", () => {
      const html = renderAuthPage(
        "login",
        {
          actionUrl: "/api/auth/sign-in/email",
          redirectTo: "/",
          appSlug: "",
          authUrl: "https://auth.example.com",
          errorMessage: "Invalid credentials",
        },
        null,
        NO_EXTERNAL_DIR,
      );

      expect(html).toContain("Invalid credentials");
    });
  });

  describe("register page", () => {
    it("includes oauthQuery hidden input", () => {
      const rawQs = "client_id=app&sig=xyz";
      const html = renderAuthPage(
        "register",
        {
          actionUrl: "/api/auth/sign-up/email",
          redirectTo: "/",
          appSlug: "app",
          authUrl: "https://auth.example.com",
          oauthQuery: rawQs,
        },
        null,
        NO_EXTERNAL_DIR,
      );

      expect(html).not.toContain("{{OAUTH_QUERY}}");
      expect(html).toContain('name="oauthQuery"');
      expect(html).toContain("client_id=app&amp;sig=xyz");
    });
  });

  describe("per-application template override", () => {
    it("falls back to built-in template when appSlug has no override", () => {
      // No external dir means built-in is always used regardless of appSlug
      const html = renderAuthPage(
        "login",
        {
          actionUrl: "/api/auth/sign-in/email",
          redirectTo: "/",
          appSlug: "nonexistent-app",
          authUrl: "https://auth.example.com",
        },
        "nonexistent-app",
        NO_EXTERNAL_DIR,
      );

      expect(html).toContain("</html>");
    });
  });

  describe("email-verified confirmation page", () => {
    const baseVars = {
      actionUrl: "/api/auth/sign-in/email",
      redirectTo: "/",
      appSlug: "",
      authUrl: "https://auth.example.com",
    };

    it("tells the two flows apart from the status marker", () => {
      const activated = renderAuthPage(
        "email-verified",
        { ...baseVars, confirmationStatus: "activated" },
        null,
        NO_EXTERNAL_DIR,
      );
      const updated = renderAuthPage(
        "email-verified",
        { ...baseVars, confirmationStatus: "updated" },
        null,
        NO_EXTERNAL_DIR,
      );

      // Distinct wording per flow, and neither carries the other's label.
      expect(activated).toContain("Account activated");
      expect(activated).not.toContain("Email address updated");
      expect(updated).toContain("Email address updated");
      expect(updated).not.toContain("Account activated");
    });

    it("renders the neutral wording when no status is supplied", () => {
      const html = renderAuthPage(
        "email-verified",
        baseVars,
        null,
        NO_EXTERNAL_DIR,
      );

      expect(html).toContain("Email confirmed");
      // The status variable is empty, never a raw query echo.
      expect(html).not.toContain("ACTIVATED");
    });

    it("links to the sign-in page and never to a protected area", () => {
      const html = renderAuthPage(
        "email-verified",
        { ...baseVars, loginUrl: "/login" },
        null,
        NO_EXTERNAL_DIR,
      );

      expect(html).toContain('href="/login"');
      expect(html).not.toContain("/profile");
    });

    it("honours a per-application override of the confirmation page", () => {
      const dir = mkdtempSync(join(tmpdir(), "auth-pages-test-"));
      try {
        mkdirSync(join(dir, "my-app"), { recursive: true });
        writeFileSync(
          join(dir, "my-app", "email-verified.html"),
          "<p>custom <%= it.CONFIRMATION_HEADING %></p>",
        );

        const html = renderAuthPage(
          "email-verified",
          { ...baseVars, appSlug: "my-app", confirmationStatus: "activated" },
          "my-app",
          dir,
        );

        expect(html).toContain("custom Account activated");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("allowRegister substitution", () => {
    it("injects ALLOW_REGISTER as the boolean literal true", () => {
      const html = renderAuthPage(
        "login",
        {
          actionUrl: "/api/auth/sign-in/email",
          redirectTo: "/",
          appSlug: "",
          authUrl: "https://auth.example.com",
          allowRegister: true,
        },
        null,
        NO_EXTERNAL_DIR,
      );

      expect(html).not.toContain("{{ALLOW_REGISTER}}");
      expect(html).toContain("const allowRegister = true");
      expect(html).not.toContain("const allowRegister = 'true'");
    });

    it("injects ALLOW_REGISTER as the boolean literal false", () => {
      const html = renderAuthPage(
        "login",
        {
          actionUrl: "/api/auth/sign-in/email",
          redirectTo: "/",
          appSlug: "",
          authUrl: "https://auth.example.com",
          allowRegister: false,
        },
        null,
        NO_EXTERNAL_DIR,
      );

      expect(html).not.toContain("{{ALLOW_REGISTER}}");
      expect(html).toContain("const allowRegister = false");
    });

    it("defaults ALLOW_REGISTER to the boolean true when allowRegister is omitted", () => {
      const html = renderAuthPage(
        "login",
        {
          actionUrl: "/api/auth/sign-in/email",
          redirectTo: "/",
          appSlug: "",
          authUrl: "https://auth.example.com",
          // allowRegister intentionally omitted
        },
        null,
        NO_EXTERNAL_DIR,
      );

      expect(html).not.toContain("{{ALLOW_REGISTER}}");
      expect(html).toContain("const allowRegister = true");
    });
  });
});
