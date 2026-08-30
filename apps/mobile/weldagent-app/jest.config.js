// Jest config for the WeldAgent mobile app.
//
// Deliberately NOT the `jest-expo` preset: under Expo SDK 54 + pnpm it drags in
// Expo's "winter" runtime, which fails to load inside the jest sandbox in this
// monorepo. The units under test are pure logic so a plain babel-jest
// transform plus a few module stubs is sufficient. Matches weldbooks-app.
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
    'lib/**/*.{ts,tsx}',
    'services/**/*.{ts,tsx}',
    'utils/**/*.{ts,tsx}',
    '!**/node_modules/**',
    '!**/__tests__/**',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^expo/virtual/env$': '<rootDir>/__mocks__/expo-virtual-env.js',
    '^@weldsuite/api-client/client$': '<rootDir>/__mocks__/api-client-stub.js',
    '^@weldsuite/app-api-client/domains/(.*)$': '<rootDir>/__mocks__/app-api-domains-stub.js',
    '^@weldsuite/mobile-ui/types$': '<rootDir>/__mocks__/mobile-ui-types-stub.js',
  },
};
