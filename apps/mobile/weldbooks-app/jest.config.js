// Jest config for the WeldBooks mobile app.
//
// Deliberately NOT the `jest-expo` preset: under Expo SDK 54 + pnpm it drags in
// Expo's "winter" runtime (`expo/src/winter/*`), which fails to load inside the
// jest sandbox in this monorepo. The units under test are pure logic — the API
// adapter, currency and date helpers — so a plain babel-jest transform plus a
// few module stubs is both sufficient and far more robust. Matches the setup
// weldmail-app and welddesk-app already use.
module.exports = {
  testEnvironment: 'node',
  // `configFile: false` skips the app's babel.config.js so the reanimated
  // plugin (irrelevant here) isn't loaded.
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': [
      'babel-jest',
      { configFile: false, babelrc: false, presets: ['babel-preset-expo'] },
    ],
  },
  setupFiles: ['<rootDir>/jest.setup.js'],
  // 'jest-junit' feeds the aggregated test dashboard (apps/tools/test-dashboard).
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: '<rootDir>/test-results', outputName: 'jest-junit.xml' }],
  ],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  collectCoverageFrom: [
    'lib/**/*.{ts,tsx}',
    'services/**/*.{ts,tsx}',
    'hooks/**/*.{ts,tsx}',
    '!**/node_modules/**',
    '!**/__tests__/**',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^expo/virtual/env$': '<rootDir>/__mocks__/expo-virtual-env.js',
    // Workspace + native modules pulled in transitively by the units under test.
    '^@weldsuite/api-client/client$': '<rootDir>/__mocks__/api-client-stub.js',
    '^@weldsuite/app-api-client/domains/(.*)$': '<rootDir>/__mocks__/app-api-domains-stub.js',
    '^@weldsuite/mobile-ui/types$': '<rootDir>/__mocks__/mobile-ui-types-stub.js',
  },
};
