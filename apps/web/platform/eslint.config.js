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
]
