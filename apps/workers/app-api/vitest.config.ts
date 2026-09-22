import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // JUnit output feeds the aggregated test dashboard (apps/tools/test-dashboard).
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    // Coverage feeds SonarQube Cloud (see sonar-project.properties). lcov is the
    // format the Sonar scanner reads; text keeps the local run readable.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // `cloudflare:email` is a Workers-runtime module with no node resolution;
      // point it at a test stub so route modules that import it can load.
      'cloudflare:email': path.resolve(__dirname, './src/test/stubs/cloudflare-email.ts'),
    },
  },
});
