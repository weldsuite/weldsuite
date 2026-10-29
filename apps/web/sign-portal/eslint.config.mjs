import { config } from '@weldsuite/eslint-config/react-internal'

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...config,
  {
    ignores: ['dist/**', '.wrangler/**', 'node_modules/**', 'src/routeTree.gen.ts'],
  },
  {
    // The Node server reads its settings when it starts (PORT, HOST): runtime
    // configuration of the container, not inputs of a cached build.
    files: ['node/**'],
    rules: { 'turbo/no-undeclared-env-vars': 'off' },
  },
]

export default eslintConfig
