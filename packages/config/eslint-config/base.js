import js from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier"
import onlyWarn from "eslint-plugin-only-warn"
import turboPlugin from "eslint-plugin-turbo"
import tseslint from "typescript-eslint"

/**
 * An `_` prefix is how you mark a binding as deliberately unused — required
 * positional params, discarded destructured keys, ignored catch bindings.
 * Without this, there is no way to express that intent.
 *
 * Exported because every preset that spreads `tseslint.configs.recommended`
 * has to re-apply this AFTER that spread, or the recommended preset's own
 * `no-unused-vars` entry wins and these options are silently dropped.
 */
export const unusedVarsRule = {
  "@typescript-eslint/no-unused-vars": [
    "warn",
    {
      args: "after-used",
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrors: "all",
      caughtErrorsIgnorePattern: "^_",
      destructuredArrayIgnorePattern: "^_",
      ignoreRestSiblings: true,
    },
  ],
}

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config}
 * */
export const config = [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
      ...unusedVarsRule,
    },
  },
  {
    plugins: {
      onlyWarn,
    },
  },
  {
    ignores: ["dist/**"],
  },
]
