import { config } from '@weldsuite/eslint-config/react-internal'

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...config,
  {
    ignores: ['dist/**', 'node_modules/**', 'src/routeTree.gen.ts'],
  },
  {
    files: ['node/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    // The Node server reads its settings when it starts (PORT, HOST): runtime
    // configuration of the container, not inputs of a cached build.
    files: ['node/**'],
    rules: { 'turbo/no-undeclared-env-vars': 'off' },
  },
]

export default eslintConfig
