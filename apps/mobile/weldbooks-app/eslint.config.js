// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
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
]);
