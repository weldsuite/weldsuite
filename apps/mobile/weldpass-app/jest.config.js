// Jest config for WeldPass.
//
// No `jest-expo` preset: under pnpm it drags in Expo's "winter" runtime
// (`expo/src/winter/*`), which fails to load inside the jest sandbox in this
// monorepo (same as WeldHR). The units tested here are pure logic and wiring
// that never render real React Native components; native modules are mocked
// per test.

module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\.(js|jsx|ts|tsx)$': [
      'babel-jest',
      { configFile: false, babelrc: false, presets: ['babel-preset-expo'] },
    ],
  },
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: '<rootDir>/test-results', outputName: 'jest-junit.xml' }],
  ],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  collectCoverageFrom: ['lib/**/*.{ts,tsx}', 'hooks/**/*.{ts,tsx}', '!**/node_modules/**', '!**/__tests__/**'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^expo/virtual/env$': '<rootDir>/__mocks__/expo-virtual-env.js',
  },
};
