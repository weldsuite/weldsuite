// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = defineConfig([
  expoConfig,
  {
    // `@weldsuite/mobile-ui` exposes its modules through subpath `exports`
    // wildcards, which eslint-plugin-import's default node resolver can't
    // follow. TypeScript already resolves them, so point the plugin at the
    // same resolution it uses.
    settings: {
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // Match the `_` convention the rest of the monorepo uses (see
      // packages/config/eslint-config/base.js) — eslint-config-expo doesn't
      // set these options, so a `_`-prefixed binding was still reported.
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
  {
    // Jest globals for the test suite.
    files: ['**/__tests__/**', '**/__mocks__/**', '**/*.test.{ts,tsx,js,jsx}', 'jest.setup.js', 'jest.config.js'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      // Tests re-`require()` a module after mutating process.env so it
      // re-evaluates; a static import would be hoisted and cached.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Metro/Babel/Jest config files run in Node, not the RN runtime.
    files: ['*.config.js', 'scripts/**'],
    languageOptions: {
      globals: {
        __dirname: 'readonly',
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // `.expo/` and the expo-router type shims are generated.
    ignores: ['dist/*', '.expo/*', 'expo-env.d.ts', '**/*.d.ts'],
  },
]);
