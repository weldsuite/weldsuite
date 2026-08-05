// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // Build/tooling scripts and Jest setup run in Node, not the RN bundle, so
    // they need Node + Jest globals instead of the React Native ones.
    files: ['scripts/**', '__mocks__/**', 'jest.setup.js', '**/*.cjs', '**/*.test.*', '**/__tests__/**'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },
  {
    // Same '_' opt-out the rest of the monorepo uses (packages/config/eslint-config):
    // an underscore marks a binding as deliberately unused — required positional
    // params, discarded destructured keys, ignored catch bindings.
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
]);
