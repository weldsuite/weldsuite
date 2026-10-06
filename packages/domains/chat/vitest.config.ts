import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'forks',
    // Coverage feeds SonarQube Cloud (see sonar-project.properties). lcov paths
    // are written relative to the repo root so Sonar can match them.
    coverage: {
      provider: 'v8',
      reporter: ['text', ['lcov', { projectRoot: path.resolve(__dirname, '../../..') }]],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/testing/**'],
    },
  },
});
