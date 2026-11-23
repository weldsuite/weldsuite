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
]

export default eslintConfig
