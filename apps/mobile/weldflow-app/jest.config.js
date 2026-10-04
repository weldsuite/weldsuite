/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': [
      'babel-jest',
      { configFile: false, babelrc: false, presets: ['babel-preset-expo'] },
    ],
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // babel-preset-expo routes `process.env.EXPO_PUBLIC_*` through this
    // untransformed-ESM module; the stub lets services/app-api.ts load.
    '^expo/virtual/env$': '<rootDir>/__mocks__/expo-virtual-env.js',
  },
  clearMocks: true,
};
