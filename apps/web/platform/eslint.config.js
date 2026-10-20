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
]
