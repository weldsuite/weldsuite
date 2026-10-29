import { config } from "@weldsuite/eslint-config/react-internal"

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    ignores: [
      "dist/**",
      "src/routeTree.gen.ts",
      "public/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "e2e/**",
      "*.config.ts",
      "*.config.js",
    ],
  },
  {
    // FE-013: `/w/{workspace}` links go through lib/workspace-url, which
    // encodes the ref and keeps one place that knows the prefix.
    ignores: ["lib/workspace-url.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TemplateLiteral > TemplateElement:first-child[value.raw=/^\\/w\\/$/]",
          message: "Build /w/{workspace} paths with workspacePath() from @/lib/workspace-url.",
        },
        {
          selector: "BinaryExpression[operator='+'][left.value='/w/']",
          message: "Build /w/{workspace} paths with workspacePath() from @/lib/workspace-url.",
        },
      ],
    },
  },
  {
    // SEC-012 / P4 4.F1: the platform reaches its identity provider through
    // the auth facade, so a deployment can swap Clerk for OIDC. Only the
    // facade itself imports Clerk. (The shared config makes every rule a
    // warning; lib/auth/no-direct-clerk-imports.test.ts is the blocking check.)
    ignores: ["lib/auth/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@clerk/*"],
              message:
                "Import auth from @/lib/auth (Clerk-only screens: @/lib/auth/clerk inside <ClerkOnly>).",
            },
          ],
        },
      ],
    },
  },
]
