import { nextJsConfig } from '@weldsuite/eslint-config/next-js'

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...nextJsConfig,
  {
    ignores: ['.next/**', 'node_modules/**', 'public/**'],
  },
]

export default eslintConfig
