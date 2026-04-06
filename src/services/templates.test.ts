import { describe, it, expect } from "vitest";
import { renderAuthPage } from "./templates.js";

// The built-in login/register templates are used (no external templates dir).
const NO_EXTERNAL_DIR = null;

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
});
