// Jest config for the WeldMail mobile app.
//
// We deliberately do NOT use the `jest-expo` preset here. Under Expo SDK 54 +
// pnpm, that preset drags in Expo's "winter" runtime (`expo/src/winter/*`),
// which fails to load inside the jest sandbox in this monorepo (the canonical
// weldsuite-app preset is currently broken in the same way). The units we test
// are pure logic + lightweight hooks that never render real React Native
// components, so a plain babel-jest transform plus a handful of module stubs is
// both sufficient and far more robust.
//
// `@testing-library/react-native` / `jest-expo` remain installed so component
// tests can be added later under a dedicated project if needed.
module.exports = {
  testEnvironment: 'node',
  // Transform our app + test sources with babel-preset-expo (handles TS + JSX).
  // `configFile: false` skips the app's babel.config.js so the reanimated babel
  // plugin (irrelevant to these tests) isn't loaded.
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
    'utils/**/*.{ts,tsx}',
    'contexts/**/*.{ts,tsx}',
    'services/**/*.{ts,tsx}',
    '!**/node_modules/**',
    '!**/__tests__/**',
  ],
  moduleNameMapper: {
    // Path alias used throughout the app.
    '^@/(.*)$': '<rootDir>/$1',
    // babel-preset-expo rewrites EXPO_PUBLIC_* env reads through this virtual
    // module, which ships as untransformed ESM — stub it with live process.env.
    '^expo/virtual/env$': '<rootDir>/__mocks__/expo-virtual-env.js',
    // Stub the workspace + native modules pulled in transitively by the units
    // under test, so importing app code stays light and resolvable under jest.
    '^@weldsuite/api-client/client$': '<rootDir>/__mocks__/api-client-stub.js',
    '^@weldsuite/app-api-client/domains/(.*)$': '<rootDir>/__mocks__/app-api-domains-stub.js',
    '^@weldsuite/mobile-ui/contexts/ClerkAuthContext$':
      '<rootDir>/__mocks__/clerk-auth-context-stub.js',
  },
};
