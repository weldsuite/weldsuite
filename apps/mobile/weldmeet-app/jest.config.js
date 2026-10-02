// Jest config for the WeldMeet mobile app. Same approach as weldmail-app: no
// `jest-expo` preset (its winter runtime does not load under pnpm in this
// monorepo); plain babel-jest over the pure logic in `utils/`.
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\.(js|jsx|ts|tsx)$': [
      'babel-jest',
      { configFile: false, babelrc: false, presets: ['babel-preset-expo'] },
    ],
  },
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  testPathIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
};
