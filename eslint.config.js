import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "frontend-dist/**",
      "coverage/**",
      "drizzle/**",
      "frontend/**",
      "docs-site/**",
      "tests/**",
      ".kilo/**",
      "node_modules/**",
      "**/*.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // The resources domain reads identity (users, memberships, plans, bans,
  // organizations) through `identity-facts.ts`, so it can be served by another
  // component later. A file listed below still reads the identity tables
  // directly; moving one of them behind `identity-facts.ts` removes it from the
  // list, and the list never grows.
  {
    files: ["src/services/resources/**/*.ts"],
    ignores: [
      "src/services/resources/identity-facts.ts",
      "src/services/resources/**/*.test.ts",
      ...[
        "access",
        "application-scope",
        "apps",
        "audience",
        "authority",
        "auto-declaration",
        "catalogue-app",
        "grant-views",
        "grants",
        "invitations",
        "model-candidates",
        "monitoring",
        "realtime",
        "registry",
        "scheme-service",
        "usage",
        "webhook-events",
        "webhooks",
      ].map((name) => `src/services/resources/${name}.ts`),
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/schema.js", "**/db/auth-schema.js"],
              message:
                "Read identity through services/resources/identity-facts.ts.",
            },
          ],
        },
      ],
    },
  },
);
