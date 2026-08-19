// Jest config for WeldStash.
//
// We deliberately do NOT use the `jest-expo` preset here. Under Expo SDK 54 +
// pnpm, that preset drags in Expo's "winter" runtime (`expo/src/winter/*`),
// which fails to load inside the jest sandbox in this monorepo. The units we
// test are pure logic + wiring that never render real React Native components.

module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': [
      'babel-jest',
      { configFile: false, babelrc: false, presets: ['babel-preset-expo'] },
    ],
  },
  setupFiles: ['<rootDir>/jest.setup.js'],
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: '<rootDir>/test-results', outputName: 'jest-junit.xml' }],
  ],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  collectCoverageFrom: [
    'utils/**/*.{ts,tsx}',
    'services/**/*.{ts,tsx}',
    'lib/**/*.{ts,tsx}',
    'modules/zebra-datawedge/index.ts',
    '!**/node_modules/**',
    '!**/__tests__/**',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^expo/virtual/env$': '<rootDir>/__mocks__/expo-virtual-env.js',
    '^@weldsuite/api-client/client$': '<rootDir>/__mocks__/api-client-stub.js',
    '^@weldsuite/app-api-client/domains/(.*)$': '<rootDir>/__mocks__/app-api-domains-stub.js',
  },
};
