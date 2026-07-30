import { nextJsConfig } from '@weldsuite/eslint-config/next-js'

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...nextJsConfig,
  {
    // CommonJS Node config file — linting it under the app's browser/ESM
    // globals just reports `module` as undefined. Same exclusion as `admin`.
    ignores: ['.next/**', 'node_modules/**', 'postcss.config.js'],
  },
]

export default eslintConfig
