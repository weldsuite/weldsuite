module.exports = {
  preset: 'jest-expo/universal',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|lucide-react-native)',
  ],
  setupFiles: ['<rootDir>/jest.setup.js'],
  setupFilesAfterEnv: [],
  // 'jest-junit' feeds the aggregated test dashboard (apps/tools/test-dashboard).
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: '<rootDir>/test-results', outputName: 'jest-junit.xml' }],
  ],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/__tests__/**/*.test.tsx',
  ],
  collectCoverageFrom: [
    '**/*.{ts,tsx}',
    '!**/coverage/**',
    '!**/node_modules/**',
    '!**/babel.config.js',
    '!**/jest.setup.js',
    '!**/.expo/**',
    '!**/app/**',
    '!**/components/**',
    '!**/contexts/**',
    '!**/services/**',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^react-native$': 'react-native-web',
  },
  testEnvironment: 'node',
};
