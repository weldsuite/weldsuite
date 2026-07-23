// This configuration only applies to the package manager root.
/** @type {import("eslint").Linter.Config} */
module.exports = {
  ignorePatterns: ["apps/**", "packages/**", "node_modules/**", ".next/**", "dist/**"],
  extends: [],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: false,
  },
  rules: {},
}